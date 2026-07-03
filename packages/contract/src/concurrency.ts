// packages/contract/src/concurrency.ts
//
// Shared concurrency control for the whole workspace. Lives on the spine so every package
// caps `claude` subprocess spawning identically.
//
// Why: when AI features run against the local Claude Code CLI (USE_CLAUDE_CODE=true), every
// model call spawns a `claude` subprocess that costs hundreds of MB of RAM. Pipelines fan
// those calls out with unbounded Promise.all (behavior: findings × refuter panel; structure:
// routes/controllers/models/pages in parallel), so without a cap a run can spawn dozens of
// `claude` processes at once and exhaust memory. Gating every spawn through one shared limiter
// — sized by CLAUDE_CODE_MAX_CONCURRENCY — bounds the whole run regardless of fan-out shape.

/** How many `claude` subprocesses may run at once when no explicit cap is given. */
export const DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY = 3

/** The CLI concurrency cap is configured per-run with this env var. */
export const CLAUDE_CODE_MAX_CONCURRENCY_ENV = "CLAUDE_CODE_MAX_CONCURRENCY"

type Env = Record<string, string | undefined>

/** Resolve the CLI concurrency cap: explicit option → env var → built-in default. */
export function resolveClaudeCodeConcurrency(
  option?: number,
  env: Env = process.env,
): number {
  if (typeof option === "number") return option
  const fromEnv = Number(env[CLAUDE_CODE_MAX_CONCURRENCY_ENV])
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY
}

/** A function that gates async thunks so no more than `max` run concurrently. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

/**
 * Build a limiter that runs at most `max` tasks concurrently (queued FIFO). A `max` below 1
 * is clamped to 1 so the limiter can never deadlock at zero concurrency. Rejections release
 * their slot just like successful completions, so a failing task never stalls the queue.
 */
export function makeLimiter(max: number): Limiter {
  const ceiling = Math.max(1, Math.floor(max) || 1)
  let active = 0
  const queue: Array<() => void> = []

  const release = (): void => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }

  const acquire = (): Promise<void> => {
    if (active < ceiling) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1
        resolve()
      })
    })
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}
