// packages/cli/src/commands/behavior-spawn.ts
//
// The loop-e2e spawn sequence for `crawl-kit run`'s behavior phase, extracted from
// index.ts so it's unit-testable with an injected spawn function. Orchestrates
// `loop-e2e run` (crawl) → optionally `loop-e2e crud` → `loop-e2e emit`.
//
// The crud step fills each transaction's `persisted` verdict (emit reads the
// *.crud-results.json crud leaves behind). It only runs when the workspace has a
// DB + a reseed path + a form-auth target[0] configured — mirroring runCrud's own
// preconditions (behavior/src/cli/commands/crud.ts), which refuse to run
// destructively without a way to restore the DB. When the gate is off, crud is
// skipped and `persisted` stays unset (documented behavior, not a bug).

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceConfig } from "@crawl-kit/behavior";

/** Suffix of the per-run CRUD results artifact emit reads to fill tx `persisted`.
 *  Source of truth: @crawl-kit/behavior services/crud/types.ts CRUD_RESULTS_SUFFIX
 *  (not part of behavior's public API, so mirrored here rather than imported). */
const CRUD_RESULTS_SUFFIX = ".crud-results.json";

/** `node <bin> <args>` runner injected by callers (real: spawnNodeAsync in index.ts). */
export type BehaviorSpawn = (bin: string, args: string[], cwd: string) => Promise<number>;

/** Result of the crud gate: ok=true → crud runs; ok=false carries the human reason. */
export type CrudGate = { ok: true } | { ok: false; reason: string };

/** Mirror runCrud's own preconditions ("DB + reseed + form auth configured"). Returns
 *  a reason on failure so the skip can be explained in the log. The selected target is
 *  targets[0] — the same default runCrud uses when no --target is passed. */
export function shouldRunCrud(config: WorkspaceConfig): CrudGate {
  if (config.databases.length === 0) return { ok: false, reason: "databases 未設定" };
  if (!config.launch?.seed) return { ok: false, reason: "launch.seed（reseed）未設定" };
  const target = config.targets[0];
  if (!target?.auth || target.auth.strategy === "none") {
    return { ok: false, reason: "target[0] に form auth 未設定" };
  }
  return { ok: true };
}

/** Remove pre-existing *.crud-results.json so a skipped-crud run's emit can't annotate
 *  tx `persisted` from a PRIOR run's stale results — loadLatestCrudResults picks the
 *  newest across ALL runs by mtime, so a leftover file would masquerade as this run's.
 *  Missing runs dir → nothing to clear. */
async function clearStaleCrudResults(cwd: string): Promise<void> {
  const runsDir = join(cwd, ".e2e", "runs");
  let files: string[];
  try {
    files = await readdir(runsDir);
  } catch {
    return;
  }
  await Promise.all(
    files.filter((f) => f.endsWith(CRUD_RESULTS_SUFFIX)).map((f) => rm(join(runsDir, f)).catch(() => {})),
  );
}

export type BehaviorSpawnOutcome = { ok: boolean };

/** run → [crud] → emit. Returns ok=false only when the crawl (`run`) itself fails; crud
 *  is best-effort (a non-zero crud exit logs but does NOT fail the phase — crawl+emit are
 *  still valuable). Gate off drops stale crud-results before emit (stale-artifact guard).
 *
 *  Note: the crud-ON-but-crud-failed edge (crud aborts before writing on e.g. auth
 *  failure, potentially leaving a prior run's stale file for emit) is out of scope here —
 *  the guard covers the gate-off path the run orchestrator actually takes when unconfigured. */
export async function runBehaviorSpawns(
  loopE2e: string,
  cwd: string,
  gate: CrudGate,
  spawn: BehaviorSpawn,
): Promise<BehaviorSpawnOutcome> {
  const runCode = await spawn(loopE2e, ["run"], cwd);
  if (runCode !== 0) {
    console.warn(`behavior: loop-e2e run が失敗 (exit ${runCode})。config/ターゲット/ブラウザを確認してください。`);
    return { ok: false };
  }

  if (gate.ok) {
    const crudCode = await spawn(loopE2e, ["crud"], cwd);
    if (crudCode !== 0) {
      console.warn(`behavior: loop-e2e crud が失敗 (exit ${crudCode})。今回の persisted は埋まりません。`);
    }
  } else {
    await clearStaleCrudResults(cwd);
    console.log(`behavior: crud skip（${gate.reason}）— tx persisted は未設定のままです`);
  }

  await spawn(loopE2e, ["emit"], cwd);
  return { ok: true };
}
