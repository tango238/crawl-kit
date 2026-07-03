// crawl-kit clear — phase-scoped artifact reset (spec C: "テスト用にクリアして
// 一から再生成"). P2's `run --force` calls clearPhase before re-running so a
// forced rebuild starts from a clean slate for the phase(s) in question.
//
// Deletion mapping (see task-4-brief.md for the source table):
//   intent     data/intent.nodes.json, data/intent.aggregates.json
//   structure  data/structure.* (nodes/rdra/er.mmd/usecases.mmd/routes.partial —
//              NOT structure.corrections.json, a human asset), workspace + each
//              repo's .crawl-kit-cache/, acquisition.structure → {}
//   behavior   data/behavior.nodes.json, data/behavior.transactions.jsonl,
//              data/behavior.edges.json, data/behavior.sitemap.json,
//              .e2e/runs, .e2e/reports (recursive; .e2e/baseline,
//              .e2e/known-findings, .e2e/feedback are kept), acquisition.behavior → {}
//   (none)     all three phases above + data/unified.json,
//              verification.findings.json, boundary.findings.json,
//              mapping.aggregate-entity.json (derived artifacts) —
//              registry.json / decisions.json / corrections.json are kept
//              unless --all
//   --all      (none) + data/registry.json + data/decisions.json

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DATA_FILES,
  emptyProgress,
  findWorkspaceRoot,
  progressPath,
  readProgressOrEmpty,
  workspaceConfigPath,
  writeProgress,
  type PhaseName,
  type Progress,
} from "@crawl-kit/contract";
import { acquisitionPath, readStore, writeStore } from "@crawl-kit/freshness";
import { readYamlFile } from "./yaml-io.js";

export type ClearablePhase = "intent" | "structure" | "behavior";
export type ClearOpts = { all?: boolean };

type WorkspaceRepoLite = { name?: string; path?: string };
type WorkspaceConfigLite = { repositories?: WorkspaceRepoLite[] };

function dataFile(root: string, name: string): string {
  return join(root, "data", name);
}

// behavior's .e2e state dir — kept as a literal (mirroring the "data" literal above) rather than
// importing STATE_DIR from @crawl-kit/behavior, to avoid a build-order dependency on that
// package's dist output. Canonical source: packages/behavior/src/state/paths.ts.
const E2E_STATE_DIR = ".e2e";

/** `rm(path, { force: true })`, recording `path` only when it actually existed. */
async function removeFile(path: string, removed: string[]): Promise<void> {
  if (existsSync(path)) removed.push(path);
  await rm(path, { force: true });
}

/** `rm(dir, { recursive: true, force: true })`, recording `dir` only when it existed. */
async function removeDir(dir: string, removed: string[]): Promise<void> {
  if (existsSync(dir)) removed.push(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Absolute paths of every configured repo's checkout dir (loose read — no env resolution needed). */
async function repoDirs(root: string): Promise<string[]> {
  const cfgPath = workspaceConfigPath(root);
  if (!existsSync(cfgPath)) return [];
  try {
    const cfg = await readYamlFile<WorkspaceConfigLite>(cfgPath);
    return (cfg.repositories ?? [])
      .filter((r): r is WorkspaceRepoLite & { name: string } => Boolean(r.name || r.path))
      .map((r) => join(root, r.path ?? r.name ?? ""));
  } catch {
    return [];
  }
}

/** Reset one phase's acquisition-freshness bucket to `{}`, keeping the store's ttlSeconds. */
async function resetAcquisition(root: string, phase: "structure" | "behavior", removed: string[]): Promise<void> {
  const storePath = acquisitionPath(root);
  const store = await readStore(storePath);
  await writeStore(storePath, { ...store, [phase]: {} });
  removed.push(`acquisition.${phase}`);
}

async function clearIntentArtifacts(root: string, removed: string[]): Promise<void> {
  await removeFile(dataFile(root, DATA_FILES.intentNodes), removed);
  await removeFile(dataFile(root, DATA_FILES.intentAggregates), removed);
}

async function clearStructureArtifacts(root: string, removed: string[]): Promise<void> {
  await removeFile(dataFile(root, DATA_FILES.structureNodes), removed);
  await removeFile(dataFile(root, DATA_FILES.structureRoutesPartial), removed);
  await removeFile(dataFile(root, "structure.er.mmd"), removed);
  await removeFile(dataFile(root, "structure.usecases.mmd"), removed);
  await removeFile(dataFile(root, "structure.rdra.json"), removed);
  // structure.corrections.json is a human asset — deliberately not removed here.
  await removeDir(join(root, ".crawl-kit-cache"), removed);
  for (const repoDir of await repoDirs(root)) {
    await removeDir(join(repoDir, ".crawl-kit-cache"), removed);
  }
  await resetAcquisition(root, "structure", removed);
}

async function clearBehaviorArtifacts(root: string, removed: string[]): Promise<void> {
  await removeFile(dataFile(root, DATA_FILES.behaviorNodes), removed);
  await removeFile(dataFile(root, DATA_FILES.behaviorTransactions), removed);
  await removeFile(dataFile(root, DATA_FILES.behaviorEdges), removed);
  await removeFile(dataFile(root, DATA_FILES.behaviorSitemap), removed);
  // .e2e/runs, .e2e/reports, and .e2e/findings are regenerated per crawl run — reset them on
  // behavior clear. .e2e/baseline, .e2e/known-findings, .e2e/feedback are deliberately kept:
  // baseline is the diff reference and known-findings/feedback are human-curated triage state.
  await removeDir(join(root, E2E_STATE_DIR, "runs"), removed);
  await removeDir(join(root, E2E_STATE_DIR, "reports"), removed);
  await removeDir(join(root, E2E_STATE_DIR, "findings"), removed);
  await resetAcquisition(root, "behavior", removed);
}

/** Fresh PhaseProgress for `phase`: status pending, tasks 0/0, blockedReason dropped.
 *  Built from scratch (not spread from the old entry) so stale timestamps and any
 *  blockedReason from a prior failed run don't linger and mislead consumers. */
function resetPhase(p: Progress, phase: PhaseName): Progress {
  return {
    ...p,
    phases: { ...p.phases, [phase]: { status: "pending", tasks: { total: 0, completed: 0 } } },
    updatedAt: new Date().toISOString(),
  };
}

async function resetProgressPhase(root: string, phase: PhaseName, removed: string[]): Promise<void> {
  const path = progressPath(root);
  const current = await readProgressOrEmpty(path, `cleared-${phase}`);
  await writeProgress(path, resetPhase(current, phase));
  removed.push(`progress.${phase}`);
}

/**
 * Delete/reset the artifacts for `phase` (or, with no phase, everything — the full
 * spec-C "clear and regenerate from scratch" reset). Returns the list of paths
 * removed and logical resets performed (empty entries are skipped silently).
 */
export async function clearPhase(root: string, phase?: ClearablePhase, opts: ClearOpts = {}): Promise<string[]> {
  const removed: string[] = [];

  if (phase === "intent") {
    await clearIntentArtifacts(root, removed);
    await resetProgressPhase(root, "intent", removed);
    return removed;
  }
  if (phase === "structure") {
    await clearStructureArtifacts(root, removed);
    await resetProgressPhase(root, "structure", removed);
    return removed;
  }
  if (phase === "behavior") {
    await clearBehaviorArtifacts(root, removed);
    await resetProgressPhase(root, "behavior", removed);
    return removed;
  }

  // no phase given: all three phases + derived artifacts + full progress reset.
  await clearIntentArtifacts(root, removed);
  await clearStructureArtifacts(root, removed);
  await clearBehaviorArtifacts(root, removed);
  await removeFile(dataFile(root, DATA_FILES.unified), removed);
  await removeFile(dataFile(root, DATA_FILES.verificationFindings), removed);
  await removeFile(dataFile(root, DATA_FILES.boundaryFindings), removed);
  await removeFile(dataFile(root, DATA_FILES.aggregateEntityMapping), removed);

  if (opts.all) {
    await removeFile(dataFile(root, DATA_FILES.registry), removed);
    await removeFile(dataFile(root, "decisions.json"), removed);
  }

  await writeProgress(progressPath(root), emptyProgress(`cleared-${new Date().toISOString()}`));
  removed.push("progress: all phases reset");

  return removed;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const USAGE = "usage: crawl-kit clear [--phase intent|structure|behavior] [--all]";

export async function cmdClear(args: string[]): Promise<void> {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) throw new Error(`${USAGE}（ワークスペース内で実行してください）`);

  // `--phase` given with no value would otherwise read as "no --phase" and fall through
  // to a full clear — a silent, surprising data-loss trap. Reject it explicitly instead.
  const phaseIndex = args.indexOf("--phase");
  if (phaseIndex >= 0 && args[phaseIndex + 1] === undefined) {
    throw new Error(USAGE);
  }
  const phaseArg = flag(args, "--phase");
  if (phaseArg !== undefined && phaseArg !== "intent" && phaseArg !== "structure" && phaseArg !== "behavior") {
    throw new Error(USAGE);
  }
  const all = args.includes("--all");

  const removed = await clearPhase(root, phaseArg as ClearablePhase | undefined, { all });
  console.log(`clear: ${phaseArg ?? "all"}${all ? " (--all)" : ""} — ${removed.length} 件削除/リセット`);
  for (const r of removed) console.log(`  ${r}`);
}
