// packages/cli/src/commands/run-phases.ts
//
// Phase bodies for `crawl-kit run` (P2 Task 5). Deliberately silent (no console
// output) — presentation lives in run.ts's cmdRunWorkspace, which decides what
// to print from the PhaseOutcome each body returns. Each body is a pure-ish
// async function: it reads config/deps from RunContext and reports progress
// through ctx.commit (a synchronous, closure-serialized ledger updater — see
// run.ts for why that matters under concurrent onUnit callbacks).

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_FILES,
  dataPath,
  readJsonFile,
  readJsonFileOr,
  writeJsonAtomic,
  withTaskCompleted,
  withTasksRegistered,
  type LayerNode,
  type Progress,
} from "@crawl-kit/contract";
import type { WorkspaceConfig } from "@crawl-kit/behavior";
import { deriveAggregates, emitIntentNodes, type Glossary } from "@crawl-kit/intent";
import { enumerateUnits } from "@crawl-kit/structure";
import { acquisitionPath, planBehaviorCrawl, readStore } from "@crawl-kit/freshness";
import { shouldRunCrud } from "./behavior-spawn.js";
import type { runDoctor } from "./doctor.js";
import type { startViewer } from "./serve.js";

/** Hooks shape `analyzeStructureRepo` is called with — mirrors structure's
 *  IncrementalOptions onPass/onUnit (kept loosely typed here so cli's RunDeps
 *  doesn't need to depend on structure's internal Extract/Merged shapes). */
export type StructureHooks = {
  onPass?: (pass: number, extract: unknown, merged: unknown) => void | Promise<void>;
  onUnit?: (pass: number, unitId: string, index: number, total: number) => void | Promise<void>;
};

/** Everything cmdRunWorkspace needs injected — index.ts (Task 6) wires these to
 *  the real cmdReconcile/cmdVerify/analyzeRepoIncremental/loop-e2e; tests inject fakes. */
export type RunDeps = {
  /** Static asset directory for the viewer (see serve.ts's startViewer). This is
   *  the primary path (the built viewer SPA); `html` below is only an inline
   *  fallback for callers/tests that don't ship a real assets dir. */
  assetsDir?: string;
  /** Optional inline HTML fallback — see serve.ts's StartViewerOptions.html. */
  html?: string;
  reconcile: () => Promise<void>;
  verify: () => Promise<void>;
  analyzeStructureRepo: (repoPath: string, hooks: StructureHooks) => Promise<void>;
  runBehavior: (cwd: string, opts: RunBehaviorOpts) => Promise<{ ok: boolean; crawledPages: number }>;
  doctor?: typeof runDoctor;
  viewer?: typeof startViewer;
  /** clock override for TTL tests (default: () => new Date()). */
  now?: () => Date;
  /** LLM-draft a Glossary when docs/domain/intent.json is missing (P3 Task 4).
   *  null = no provider configured (or drafting otherwise unavailable) — intentPhase
   *  treats null/undefined/throw identically: blocked, not a hard failure. */
  draftIntent?: (root: string) => Promise<Glossary | null>;
};

export type PhaseOutcome = { status: "completed" } | { status: "blocked"; reason: string };

/** Options behaviorPhase threads to runBehavior. `crud` gates the `loop-e2e crud`
 *  step (fills tx `persisted`); `crudSkipReason` explains an off gate for the log. */
export type RunBehaviorOpts = { crud: boolean; crudSkipReason?: string };

export interface RunContext {
  root: string;
  runId: string;
  config: WorkspaceConfig;
  deps: RunDeps;
  now: () => Date;
  /** apply a pure Progress updater to the current ledger and queue its write.
   *  Synchronous on purpose — see run.ts's writeChain for the serialization contract. */
  commit: (updater: (prev: Progress) => Progress) => void;
}

// ── intent ───────────────────────────────────────────────────────────────────

const NO_INTENT_SOURCE_REASON =
  "docs/domain/intent.json なし、LLM プロバイダも未設定 — /ddd（distill-ddd）で作成するか ANTHROPIC_API_KEY / USE_CLAUDE_CODE を設定してください";

export async function intentPhase(ctx: RunContext): Promise<PhaseOutcome> {
  const glossaryPath = join(ctx.root, "docs", "domain", "intent.json");
  let glossary: Glossary;

  if (existsSync(glossaryPath)) {
    try {
      glossary = await readJsonFile<Glossary>(glossaryPath);
    } catch (error) {
      // present but unparsable (bad JSON, unreadable, ...) — distinct from "missing"
      // so the operator knows to fix the file rather than run distill-ddd again.
      return { status: "blocked", reason: `intent.json の読み込みに失敗: ${(error as Error).message}` };
    }
    ctx.commit((p) => withTasksRegistered(p, "intent", 1));
    const nodes = emitIntentNodes(glossary, ctx.runId);
    await writeJsonAtomic(dataPath(DATA_FILES.intentNodes, ctx.root), nodes);
    ctx.commit((p) => withTaskCompleted(p, "intent", 1));
  } else {
    // No intent.json on disk — try to LLM-draft one (P3 auto-draft) before giving up.
    // 2 tasks: draft, then emit — so the ledger shows progress across both steps.
    ctx.commit((p) => withTasksRegistered(p, "intent", 2));
    let drafted: Glossary | null;
    try {
      drafted = (await ctx.deps.draftIntent?.(ctx.root)) ?? null;
    } catch (error) {
      // A provider IS configured but drafting itself failed (bad API key, network,
      // two consecutive schema-invalid responses, ...) — distinct from "no provider
      // configured" (draftIntent returning null below), so surface the real cause
      // instead of telling the operator to configure something they already did.
      return { status: "blocked", reason: `intent 自動ドラフトに失敗: ${(error as Error).message}` };
    }
    if (!drafted) {
      return { status: "blocked", reason: NO_INTENT_SOURCE_REASON };
    }
    glossary = drafted;
    ctx.commit((p) => withTaskCompleted(p, "intent", 1));
    // Persist the draft as the source of truth — subsequent runs take the "existing
    // intent.json" path above, and a human can refine it further via /ddd.
    await writeJsonAtomic(glossaryPath, glossary);
    const nodes = emitIntentNodes(glossary, ctx.runId);
    await writeJsonAtomic(dataPath(DATA_FILES.intentNodes, ctx.root), nodes);
    ctx.commit((p) => withTaskCompleted(p, "intent", 1));
  }

  const aggregates = deriveAggregates(glossary);
  await writeJsonAtomic(dataPath(DATA_FILES.intentAggregates, ctx.root), aggregates);

  return { status: "completed" };
}

// ── structure ────────────────────────────────────────────────────────────────

/** Passes the incremental engine runs per repo — used to size the structure ledger total. */
const STRUCTURE_PASS_COUNT = 3;

export async function structurePhase(ctx: RunContext): Promise<PhaseOutcome> {
  const repos = ctx.config.repositories
    .map((r) => ({ ...r, absPath: join(ctx.root, r.path ?? r.name) }))
    .filter((r) => existsSync(r.absPath));

  const total = repos.reduce((sum, r) => sum + enumerateUnits(r.absPath).length * STRUCTURE_PASS_COUNT, 0);
  ctx.commit((p) => withTasksRegistered(p, "structure", total));

  // sequential across repos — unit-level parallelism happens inside the engine (maxParallel).
  for (const repo of repos) {
    await ctx.deps.analyzeStructureRepo(repo.absPath, {
      onUnit: () => {
        ctx.commit((p) => withTaskCompleted(p, "structure", 1));
      },
    });
  }
  return { status: "completed" };
}

// ── behavior ─────────────────────────────────────────────────────────────────

async function estimateBehaviorTotal(ctx: RunContext): Promise<number> {
  try {
    const nodes = await readJsonFileOr<LayerNode[]>(dataPath(DATA_FILES.structureNodes, ctx.root), []);
    const routes = nodes.filter((n) => n.nodeId.startsWith("structure:route/")).map((n) => n.route ?? n.localName);
    const store = await readStore(acquisitionPath(ctx.root));
    const plan = planBehaviorCrawl(routes, store, ctx.now());
    return plan.toCrawl.length || 1;
  } catch {
    return 1;
  }
}

export async function behaviorPhase(ctx: RunContext): Promise<PhaseOutcome> {
  if (ctx.config.targets.length === 0) {
    return { status: "blocked", reason: "targets 未設定 — workspace.yaml に targets を記載してください" };
  }
  const total = await estimateBehaviorTotal(ctx);
  ctx.commit((p) => withTasksRegistered(p, "behavior", total));
  // Gate the crud sub-step on the workspace config (DB + reseed + form auth). When off,
  // crud is skipped so `persisted` stays unset — runBehavior logs the reason.
  const gate = shouldRunCrud(ctx.config);
  const result = await ctx.deps.runBehavior(ctx.root, {
    crud: gate.ok,
    ...(gate.ok ? {} : { crudSkipReason: gate.reason }),
  });
  ctx.commit((p) => withTaskCompleted(p, "behavior", result.crawledPages));
  if (!result.ok) throw new Error("behavior: crawl の実行に失敗しました");
  return { status: "completed" };
}

// ── reconcile / verify ───────────────────────────────────────────────────────

export async function reconcilePhase(ctx: RunContext): Promise<PhaseOutcome> {
  ctx.commit((p) => withTasksRegistered(p, "reconcile", 1));
  await ctx.deps.reconcile();
  ctx.commit((p) => withTaskCompleted(p, "reconcile", 1));
  return { status: "completed" };
}

export async function verifyPhase(ctx: RunContext): Promise<PhaseOutcome> {
  ctx.commit((p) => withTasksRegistered(p, "verify", 1));
  await ctx.deps.verify();
  ctx.commit((p) => withTaskCompleted(p, "verify", 1));
  return { status: "completed" };
}
