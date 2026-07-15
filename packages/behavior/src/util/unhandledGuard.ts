import { logger } from './logger.js'

// Long-running crawl/verify runs fan out best-effort async work (LLM subprocess calls, page
// captures). Node's default for an unhandled promise rejection is to CRASH the process — which
// turned one flaky `claude` CLI exit into the death of a whole behavior run (observed: run
// killed 19s into the crawl while login had already succeeded). Every stage already reports
// its own failures; a rejection that reaches the process level is by definition work nothing
// is waiting on, so logging it loudly and continuing is strictly better than dying.

/** Install once from the CLI entrypoint. Idempotent. */
export function installUnhandledRejectionGuard(proc: NodeJS.Process = process): void {
  if (proc.listenerCount('unhandledRejection') > 0) return
  proc.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    logger.error({ err }, 'unhandled promise rejection — continuing (stages report their own failures)')
  })
}
