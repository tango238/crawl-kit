// packages/cli/src/commands/run.ts
//
// crawl-kit run — the workspace orchestrator (P2 Task 5). One command drives the
// full pipeline (intent → structure → behavior → reconcile → verify), writing a
// resumable ledger (.crawl-kit/progress.json) as it goes: doctor blocks phases
// up front, --force clears before re-running, a completed-and-fresh phase is
// skipped, and a running-then-interrupted phase just re-runs (the structure/
// behavior engines cache at the unit/page level, so resume is cheap).
//
// Progress updates: onUnit fires concurrently (units fan out inside a
// Promise.all pool — see structure's runPasses). To keep the ledger correct
// under that, phase bodies never read-modify-write `current` across an await;
// they call `commit(updater)`, which applies the pure updater synchronously
// (current = updater(current)) and only THEN queues the write behind
// `writeChain`. Two concurrent onUnit calls can therefore never interleave a
// read with a stale write — each commit() call is atomic w.r.t. the event loop.

import { findWorkspaceRoot, progressPath, readProgressOrEmpty, writeProgress, withPhaseStatus, PHASE_NAMES, CLAUDE_CODE_MAX_CONCURRENCY_ENV, type PhaseName, type Progress } from "@crawl-kit/contract";
import { loadWorkspaceConfig } from "@crawl-kit/behavior";
import { runDoctor, blockedPhases, type BlockablePhase } from "./doctor.js";
import { startViewer, type Viewer } from "./serve.js";
import { clearPhase, type ClearablePhase } from "./clear.js";
import {
  intentPhase,
  structurePhase,
  behaviorPhase,
  reconcilePhase,
  verifyPhase,
  type RunContext,
  type RunDeps,
  type PhaseOutcome,
} from "./run-phases.js";

export type { RunDeps, StructureHooks, PhaseOutcome, RunContext } from "./run-phases.js";

const ONLY_PHASES = new Set(["intent", "structure", "behavior"]);
type OnlyPhase = "intent" | "structure" | "behavior";

const USAGE = "usage: crawl-kit run [--only intent|structure|behavior] [--force] [--no-viewer] [--port N]";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** flags that consume the following token as a value (so it isn't mistaken for a positional arg) */
const FLAGS_WITH_VALUE = new Set(["--only", "--port"]);

/** First bare (non-flag, non-flag-value) token, or undefined. Inside a workspace `run`
 *  takes no positional args — the legacy `run <repo>` form only applies outside one
 *  (see index.ts's dispatch) — so any positional here is a usage error. */
function findPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (FLAGS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

function isBlockablePhase(phase: PhaseName): phase is BlockablePhase {
  return phase === "intent" || phase === "structure" || phase === "behavior";
}

/** completedAt is within regenerateTtlSeconds of `now` — the resume "skip" gate. */
function isFresh(completedAt: string | undefined, ttlSeconds: number, now: Date): boolean {
  if (!completedAt) return false;
  return now.getTime() - Date.parse(completedAt) < ttlSeconds * 1000;
}

const PHASE_BODIES: Record<PhaseName, (ctx: RunContext) => Promise<PhaseOutcome>> = {
  intent: intentPhase,
  structure: structurePhase,
  behavior: behaviorPhase,
  reconcile: reconcilePhase,
  verify: verifyPhase,
};

export async function cmdRunWorkspace(args: string[], deps: RunDeps): Promise<void> {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) throw new Error(`crawl-kit setup または migrate を実行してください（${USAGE}）`);

  const positional = findPositional(args);
  if (positional !== undefined) {
    throw new Error(
      `crawl-kit run: 予期しない引数 "${positional}"。ワークスペース内では repo 引数は使えません（${USAGE}）。` +
        `ワークスペース外でのレガシー用法は 'crawl-kit run <repo>' を参照してください。`,
    );
  }

  const onlyArg = flag(args, "--only");
  if (onlyArg !== undefined && !ONLY_PHASES.has(onlyArg)) throw new Error(USAGE);
  const only = onlyArg as OnlyPhase | undefined;
  const force = args.includes("--force");
  const noViewer = args.includes("--no-viewer");
  const port = Number(flag(args, "--port") ?? process.env["PORT"] ?? 4317);

  if (force) {
    const removed = await clearPhase(root, only as ClearablePhase | undefined);
    console.log(`run: --force — ${only ?? "全フェーズ"} をクリア（${removed.length} 件）`);
  }

  const { config } = await loadWorkspaceConfig(root);
  if (!process.env[CLAUDE_CODE_MAX_CONCURRENCY_ENV]) {
    process.env[CLAUDE_CODE_MAX_CONCURRENCY_ENV] = String(config.maxParallel);
  }

  const now = deps.now ?? ((): Date => new Date());
  const runId = `run-${Date.now()}`;

  let current = await readProgressOrEmpty(progressPath(root), runId);
  let writeChain: Promise<void> = Promise.resolve();
  const commit = (updater: (prev: Progress) => Progress): void => {
    current = updater(current);
    const snapshot = current;
    writeChain = writeChain.then(() => writeProgress(progressPath(root), snapshot));
  };
  /** Await every queued ledger write so far. Phase bodies can run long (behavior's
   *  crawl spawn in particular) — calling this right before a body executes ensures
   *  progress.json on disk reflects the "running" commit() just made, instead of
   *  lagging behind the in-memory `current` for the body's whole duration. */
  const flush = (): Promise<void> => writeChain;

  const doctorFn = deps.doctor ?? runDoctor;
  const checks = await doctorFn(root);
  const blocked = blockedPhases(checks);
  for (const [phase, reason] of blocked) {
    commit((p) => withPhaseStatus(p, phase, "blocked", { reason }));
    console.log(`${phase}: blocked — ${reason}`);
  }

  let viewer: Viewer | undefined;
  if (!noViewer) {
    const startViewerFn = deps.viewer ?? startViewer;
    viewer = await startViewerFn({ port, host: "0.0.0.0", html: deps.html, assetsDir: deps.assetsDir });
    console.log(`crawl-kit: viewer at http://localhost:${viewer.port}  （ダッシュボード + 4メニュー）`);
    for (const url of viewer.urls) {
      if (!url.startsWith("http://localhost:")) console.log(`  同じネットワークのスマホ等から: ${url.replace(/\/$/, "")}`);
    }
  }

  const ctx: RunContext = { root, runId, config, deps, now, commit };
  const phaseOrder: PhaseName[] = only ? [only, "reconcile", "verify"] : [...PHASE_NAMES];
  let structureFailed = false;

  for (const phase of phaseOrder) {
    if ((phase === "behavior" || phase === "reconcile" || phase === "verify") && structureFailed) {
      console.log(`${phase}: skip（structure が failed のため）`);
      continue;
    }

    const prevPhase = current.phases[phase];
    if (prevPhase.status === "completed" && isFresh(prevPhase.completedAt, config.regenerateTtlSeconds, now())) {
      console.log(`${phase}: skip（completed, TTL(${config.regenerateTtlSeconds}s)内）`);
      continue;
    }
    if (isBlockablePhase(phase) && blocked.has(phase)) {
      console.log(`${phase}: skip（blocked — 台帳記録済み）`);
      continue;
    }

    commit((p) => withPhaseStatus(p, phase, "running"));
    console.log(`${phase}: 実行中...`);
    await flush();
    try {
      const outcome = await PHASE_BODIES[phase](ctx);
      if (outcome.status === "blocked") {
        commit((p) => withPhaseStatus(p, phase, "blocked", { reason: outcome.reason }));
        console.log(`${phase}: blocked — ${outcome.reason}`);
      } else {
        commit((p) => withPhaseStatus(p, phase, "completed"));
        console.log(`${phase}: completed`);
      }
    } catch (error) {
      commit((p) => withPhaseStatus(p, phase, "failed"));
      console.error(`${phase}: failed — ${(error as Error).message}`);
      if (phase === "structure") structureFailed = true;
    }
  }

  await writeChain;

  console.log("\n--- run summary ---");
  for (const phase of PHASE_NAMES) {
    const p = current.phases[phase];
    const reason = p.blockedReason ? ` (${p.blockedReason})` : "";
    console.log(`  ${phase.padEnd(10)} ${p.status.padEnd(10)} ${p.tasks.completed}/${p.tasks.total}${reason}`);
  }

  if (viewer) console.log("\nCtrl-C で終了");
}
