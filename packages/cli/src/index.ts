#!/usr/bin/env node
// packages/cli/src/index.ts
//
// `crawl-kit` — one entrypoint over the spine, so the suite is usable via npx
// without the pnpm-monorepo plumbing. Subcommands wrap the packages' programmatic
// APIs; data/ is resolved at the user's project root (nearest package.json).
//
//   crawl-kit demo                 run the bundled sample end-to-end
//   crawl-kit analyze <repo>       structure + behavior (both freshness-gated)
//   crawl-kit analyze-structure <repo>  static analysis only → data/structure.*.json
//   crawl-kit analyze-behavior     crawl the live app via loop-e2e → data/behavior.nodes.json
//   crawl-kit intent <glossary>    emit intent nodes      → data/intent.nodes.json
//   crawl-kit reconcile            join the three layers  → data/unified.json
//   crawl-kit verify               concept + boundary checks → data/*.findings.json
//   crawl-kit serve [--port N]     live viewer (差分 tab integrated)
//
// (Crawling the running app — the behavior layer — stays in loop-e2e: it needs a
// browser/db and is intentionally out of this lightweight CLI.)

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_FILES,
  crawlKitPath,
  dataPath,
  findWorkspaceRoot,
  readRegistryOrEmpty,
  readUnified,
  writeJsonAtomic,
  writeRegistry,
  writeUnified,
  type Adr,
  type LayerNode,
} from "@crawl-kit/contract";
import { deriveAggregates, draftGlossary, emitIntentNodes, type DraftInput, type Glossary } from "@crawl-kit/intent";
import { analyzeRepo, analyzeRepoIncremental, enumerateUnits, getProvider, writeStructureOutputs, type StructureExtract } from "@crawl-kit/structure";
import { ingestLayerNodes, reconcile, type HumanDecision } from "@crawl-kit/reconciler";
import { writeAggregateMapping } from "./commands/aggregate-mapping-io.js";
import { buildReport, buildBoundaryReport } from "@crawl-kit/verification";
import {
  scanByDir,
  staleDirs,
  recordStructure,
  planBehaviorCrawl,
  recordBehavior,
  readStore,
  writeStore,
  acquisitionPath,
  DEFAULT_TTL_SECONDS,
} from "@crawl-kit/freshness";
import { cmdSetup } from "./commands/setup.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdMigrate } from "./commands/migrate.js";
import { cmdServe } from "./commands/serve.js";
import { cmdClear } from "./commands/clear.js";
import { cmdRunWorkspace, type RunDeps, type StructureHooks } from "./commands/run.js";
import { runBehaviorSpawns, type CrudGate } from "./commands/behavior-spawn.js";
import type { RunBehaviorOpts } from "./commands/run-phases.js";
import { mergedExtract, prefixScan } from "./commands/structure-merge.js";
import { readYamlFile } from "./commands/yaml-io.js";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, "..", "samples");

/** Static asset dir for the viewer (see serve.ts's startViewer `assetsDir`): the
 *  bundled build's copy (`dist/viewer-public`, populated by the cli's build script)
 *  when installed, or the repo-dev source (`packages/viewer/public`) when running
 *  from `pnpm --filter @tanago3/crawl-kit start` inside this monorepo. First
 *  existing wins; undefined means neither was found — `serve`/`run` then fail with
 *  a clear error from startViewer (see serve.ts) instead of falling back to any
 *  bundled HTML (the legacy single-page viewer was removed in P5 Task 7). */
function resolveAssetsDir(): string | undefined {
  const bundled = join(here, "viewer-public");
  if (existsSync(bundled)) return bundled;
  const dev = join(here, "../../viewer/public");
  if (existsSync(dev)) return dev;
  return undefined;
}
const ASSETS_DIR = resolveAssetsDir();

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(path);
  } catch {
    return fallback;
  }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---- subcommands ----------------------------------------------------------

async function cmdIntent(glossaryPath: string): Promise<void> {
  if (!glossaryPath) throw new Error("usage: crawl-kit intent <glossary.json>");
  const glossary = await readJson<Glossary>(resolve(glossaryPath));
  const nodes = emitIntentNodes(glossary, `intent-${process.pid}`);
  await writeJson(dataPath(DATA_FILES.intentNodes), nodes);
  const aggregates = deriveAggregates(glossary);
  await writeJsonAtomic(dataPath(DATA_FILES.intentAggregates), aggregates);
  const kind = (p: string) => nodes.filter((n) => n.nodeId.startsWith(p)).length;
  console.log(
    `intent: ${kind("intent:concept/")} concept, ${kind("intent:event/")} event, ${kind("intent:transition/")} transition node(s), ${aggregates.aggregates.length} aggregate(s)`,
  );
}

async function cmdStructureExtract(extract: StructureExtract): Promise<void> {
  const { counts } = await writeStructureOutputs(extract, `structure-${process.pid}`);
  console.log(`structure: ${counts.entities} entities, ${counts.routes} routes, ${counts.usecases} usecases, ${counts.gaps} CRUD gap(s)`);
}

/** Parse `--pass 1,2` (or `--pass 2`) into an ordered pass list, or undefined for all. */
function parsePasses(args: string[]): number[] | undefined {
  const raw = flag(args, "--pass");
  if (!raw) return undefined;
  const nums = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 3);
  return nums.length ? nums : undefined;
}

async function cmdAnalyzeStructure(args: string[]): Promise<void> {
  const repoArg = args.find((a) => !a.startsWith("-"));
  if (!repoArg) throw new Error("usage: crawl-kit analyze-structure <repo> [--incremental] [--pass N] [--unit <substr>] [--ttl <sec>] [--force]");
  const repo = resolve(repoArg);
  const force = args.includes("--force");
  const incremental = args.includes("--incremental");
  const ttl = Number(flag(args, "--ttl")) || DEFAULT_TTL_SECONDS;
  const now = new Date();

  // freshness gate: re-acquire only when a directory is new, changed, or past TTL.
  const storePath = acquisitionPath();
  const store = { ...(await readStore(storePath, ttl)), ttlSeconds: ttl };
  const scanned = scanByDir(repo);
  const stale = staleDirs(store, scanned, now);
  const firstRun = Object.keys(store.structure).length === 0;

  if (!force && !firstRun && stale.length === 0) {
    console.log(`structure: 鮮度OK — 変更なし & TTL(${ttl}s)内のため再取得をスキップ（${scanned.size} dir 監視）`);
    return;
  }
  const why = force ? "--force" : firstRun ? "初回取得" : `${stale.length} dir 変化/期限切れ`;

  if (incremental) {
    const provider = await runIncremental(repo, args, force);
    console.log(`structure: provider=${provider} (incremental, ${why})`);
  } else {
    console.log(`structure: 再取得 (${why})`);
    const { extract, provider } = await analyzeRepo(repo);
    console.log(`structure: provider=${provider}`);
    await cmdStructureExtract(extract);
  }

  await writeStore(storePath, recordStructure(store, scanned, now));
  console.log(`freshness: ${scanned.size} dir を記録 → ${storePath}`);
}

/**
 * Incremental structure analysis: fan-out + diff via the pass engine. Pass 1 writes a
 * routes-only partial immediately (e2e/CRUD planning can start); every pass progressively
 * refines structure.nodes.json. `--unit <substr>` narrows to matching units; the fragment
 * cache makes re-runs re-analyze only changed units (unless `--force`).
 */
async function runIncremental(repo: string, args: string[], force: boolean): Promise<string> {
  const passes = parsePasses(args);
  const unitFilter = flag(args, "--unit");
  const enumerate = unitFilter
    ? (r: string) => enumerateUnits(r).filter((u) => u.id.includes(unitFilter))
    : undefined;

  const { provider } = await analyzeRepoIncremental(repo, {
    passes,
    force,
    enumerate,
    onPass: async (pass, extract) => {
      if (pass === 1) {
        await writeJson(dataPath(DATA_FILES.structureRoutesPartial), extract.routes);
        console.log(`structure: pass1 → ${extract.routes.length} routes（partial 書き出し, 計画に使用可）`);
      }
      // progressively refine the full outputs each pass
      await cmdStructureExtract(extract);
      console.log(`structure: pass${pass} 反映完了`);
    },
  });
  return provider;
}

/** Resolve loop-e2e's bin (the behavior crawl engine), or null if not installed. */
function resolveLoopE2e(): string | null {
  try {
    return createRequire(import.meta.url).resolve("@crawl-kit/behavior/cli");
  } catch {
    return null;
  }
}

async function cmdAnalyzeBehavior(args: string[]): Promise<void> {
  const force = args.includes("--force");
  const ttl = Number(flag(args, "--ttl")) || DEFAULT_TTL_SECONDS;
  const target = flag(args, "--target");
  const now = new Date();
  const storePath = acquisitionPath();
  const store = { ...(await readStore(storePath, ttl)), ttlSeconds: ttl };

  // freshness gate: skip the (expensive, browser-driven) crawl when nothing is due.
  const structureNodes = await ingestOrEmpty(dataPath(DATA_FILES.structureNodes));
  const routes = structureNodes.filter((n) => n.nodeId.startsWith("structure:route/")).map((n) => n.route ?? n.localName);
  const plan = planBehaviorCrawl(routes, store, now);
  const everCrawled = Object.keys(store.behavior).length > 0;
  if (!force && everCrawled && plan.toCrawl.length === 0) {
    console.log(`behavior: 鮮度OK — 変化なし & TTL(${ttl}s)内のため crawl をスキップ`);
    return;
  }
  console.log(`behavior: crawl 対象 ${plan.toCrawl.length} / skip ${plan.toSkip.length} / drop ${plan.toDrop.length}`);

  const loopE2e = resolveLoopE2e();
  if (!loopE2e) {
    console.warn(
      "behavior: crawl エンジン(loop-e2e / @crawl-kit/behavior)が見つかりません。" +
        "実取得には behavior エンジンと e2e.config.yaml が必要です（structure は取得済み）。",
    );
    return;
  }

  // loop-e2e owns the real crawl (playwright + live target + config). Run it, then
  // emit behavior nodes onto the spine. cwd must hold e2e.config.yaml.
  const targetArgs = target ? ["--target", target] : [];
  const run = spawnSync("node", [loopE2e, "run", ...targetArgs], { cwd: process.cwd(), stdio: "inherit" });
  if (run.status !== 0) {
    console.warn(`behavior: loop-e2e run が失敗 (exit ${run.status ?? "?"})。config/ターゲット/ブラウザを確認してください。`);
    return;
  }
  spawnSync("node", [loopE2e, "emit"], { cwd: process.cwd(), stdio: "inherit" });

  // record freshness from what got emitted
  const after = await ingestOrEmpty(dataPath(DATA_FILES.behaviorNodes));
  const crawled = after
    .filter((n) => n.nodeId.startsWith("behavior:page/"))
    .map((n) => ({ route: n.route ?? n.localName, viewFiles: {} }));
  await writeStore(storePath, recordBehavior(store, crawled, now, crawled.map((c) => c.route)));
  console.log(`behavior: ${crawled.length} page を取得・鮮度記録`);
}

/** `analyze` = structure then behavior (both freshness-gated), then reconcile so
 * `unified.json` (viewer's route/observation-map input) is always produced. */
async function cmdAnalyze(args: string[]): Promise<void> {
  await cmdAnalyzeStructure(args);
  await cmdAnalyzeBehavior(args);
  await cmdReconcile();
}

async function cmdReconcile(): Promise<void> {
  const [intent, structure, behavior] = await Promise.all([
    ingestOrEmpty(dataPath(DATA_FILES.intentNodes)),
    ingestOrEmpty(dataPath(DATA_FILES.structureNodes)),
    ingestOrEmpty(dataPath(DATA_FILES.behaviorNodes)),
  ]);
  const adrs = process.env.ADRS_PATH ? await readJsonOr<Adr[]>(resolve(process.env.ADRS_PATH), []) : [];
  const decisions = await readJsonOr<HumanDecision[]>(dataPath("decisions.json"), []);
  const prior = await readRegistryOrEmpty(dataPath(DATA_FILES.registry));

  const { registry, unified, queue } = await reconcile(
    { intent, structure, behavior, adrs, prior, decisions },
    { direction: (process.env.DIRECTION as "intent" | "code") ?? "intent" },
  );
  await writeRegistry(dataPath(DATA_FILES.registry), registry);
  await writeUnified(dataPath(DATA_FILES.unified), unified);

  const tally = unified.concepts.reduce<Record<string, number>>((a, c) => ((a[c.state] = (a[c.state] ?? 0) + 1), a), {});
  console.log(`reconcile: ${unified.concepts.length} concept(s) [${Object.entries(tally).sort().map(([s, n]) => `${n} ${s}`).join(", ")}]`);
  if (queue.length) console.log(`  manual queue (${queue.length}): ${queue.map((q) => `${q.entity}?→${q.bestConceptId}`).join(", ")}`);

  const m = await writeAggregateMapping();
  if (m.written) console.log(`mapping: ${m.aggregates} aggregate(s), ${m.unassigned} unassigned entity(ies)`);
}

async function cmdVerify(): Promise<void> {
  const now = new Date().toISOString();
  const unified = await readUnified(dataPath(DATA_FILES.unified));
  const report = buildReport(unified, now);
  await writeJson(dataPath(DATA_FILES.verificationFindings), report);

  const [structureNodes, behaviorNodes] = await Promise.all([
    ingestOrEmpty(dataPath(DATA_FILES.structureNodes)),
    ingestOrEmpty(dataPath(DATA_FILES.behaviorNodes)),
  ]);
  const boundary = buildBoundaryReport(structureNodes, behaviorNodes, now);
  await writeJson(dataPath(DATA_FILES.boundaryFindings), boundary);

  const s = report.summary;
  console.log(`verify: ${s.total} finding(s) [${s.bug} bug, ${s.uncertain} uncertain, ${s.unnecessary} unnecessary]`);
  const b = boundary.summary;
  console.log(`boundary: ${boundary.boundaries} boundary(ies), ${b.problems} problem(s) [${b.high} high], ${b.ok} ok`);
}

/** reconcile then verify — re-derive the unified model and re-run all checks in one step. */
async function cmdCheck(): Promise<void> {
  await cmdReconcile();
  await cmdVerify();
}

/** the full pipeline: analyze (structure + behavior) → reconcile → verify, in one step. */
async function cmdRun(args: string[]): Promise<void> {
  await cmdAnalyze(args);
  await cmdCheck();
}

// ---- workspace `run` RunDeps (P2 Task 6) -----------------------------------

/**
 * Build the `analyzeStructureRepo` dep the workspace orchestrator (run.ts /
 * run-phases.ts) calls once per configured repo, sequentially. run-phases.ts's
 * structurePhase ignores this function's return value, so a multi-repo merge has
 * to live here in the closure: each call's onPass records that repo's latest
 * extract into `perRepo`, then every write recomputes the merge across ALL repos
 * seen so far (progressive refinement — the last write, after the last repo's
 * last pass, wins with everything included). With exactly one repo this reduces
 * to the same extract that repo produced — no `repo` tagging, byte-identical to
 * the legacy single-repo `runIncremental` behavior. With two or more, every
 * record across every repo is tagged `repo: <name>` (basename of its abs path).
 */
function makeAnalyzeStructureRepo(): (repoPath: string, hooks: StructureHooks) => Promise<void> {
  const perRepo = new Map<string, StructureExtract>();

  return async (repoPath, hooks) => {
    const now = new Date();
    const storePath = acquisitionPath();
    const store = await readStore(storePath);
    // namespace this repo's scanned dirs (e.g. "src/") by repo name before recording,
    // so two repos with an overlapping relative path don't overwrite each other's
    // acquisition.structure entry (see structure-merge.ts#prefixScan).
    const scanned = prefixScan(scanByDir(repoPath), basename(repoPath));

    const { provider } = await analyzeRepoIncremental(repoPath, {
      onUnit: hooks.onUnit,
      onPass: async (pass, extract, merged) => {
        perRepo.set(repoPath, extract);
        await hooks.onPass?.(pass, extract, merged);
        const combined = mergedExtract(perRepo);
        if (pass === 1) {
          await writeJson(dataPath(DATA_FILES.structureRoutesPartial), combined.routes);
          console.log(`structure: pass1 → ${combined.routes.length} routes（partial 書き出し, 計画に使用可）`);
        }
        // progressively refine the full outputs each pass, across every repo seen so far
        await cmdStructureExtract(combined);
        console.log(`structure: pass${pass} 反映完了（${basename(repoPath)}）`);
      },
    });
    console.log(`structure: provider=${provider}（${basename(repoPath)}）`);

    await writeStore(storePath, recordStructure(store, scanned, now));
  };
}

/** `node <bin> <args>` async, inheriting stdio, resolving with the exit code (never
 *  rejecting on a non-zero exit — only on a spawn-level failure, e.g. ENOENT).
 *  Unlike spawnSync, this doesn't block the event loop — the viewer stays responsive
 *  while loop-e2e's crawl (behavior's longest phase) runs. */
function spawnNodeAsync(bin: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [bin, ...args], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

/** `runBehavior` dep: reuses the loop-e2e spawn sequence (run → [crud] → emit),
 *  scoped to the workspace root, and reports back what run-phases.ts's behaviorPhase
 *  needs. The crud step (which fills tx `persisted`) is gated by behaviorPhase and
 *  passed in via opts.crud — see behavior-spawn.ts's runBehaviorSpawns. */
async function runBehaviorForWorkspace(
  cwd: string,
  opts: RunBehaviorOpts,
): Promise<{ ok: boolean; crawledPages: number }> {
  const loopE2e = resolveLoopE2e();
  if (!loopE2e) {
    console.warn(
      "behavior: crawl エンジン(loop-e2e / @crawl-kit/behavior)が見つかりません。" +
        "実取得には behavior エンジンと e2e.config.yaml が必要です。",
    );
    return { ok: false, crawledPages: 0 };
  }

  const gate: CrudGate = opts.crud ? { ok: true } : { ok: false, reason: opts.crudSkipReason ?? "DB/reseed/auth 未設定" };
  const spawnOutcome = await runBehaviorSpawns(loopE2e, cwd, gate, spawnNodeAsync);
  if (!spawnOutcome.ok) return { ok: false, crawledPages: 0 };

  const now = new Date();
  const storePath = acquisitionPath(cwd);
  const store = await readStore(storePath);
  const after = await ingestOrEmpty(dataPath(DATA_FILES.behaviorNodes, cwd));
  const crawled = after
    .filter((n) => n.nodeId.startsWith("behavior:page/"))
    .map((n) => ({ route: n.route ?? n.localName, viewFiles: {} }));
  await writeStore(storePath, recordBehavior(store, crawled, now, crawled.map((c) => c.route)));
  console.log(`behavior: ${crawled.length} page を取得・鮮度記録`);

  return { ok: true, crawledPages: crawled.length };
}

/** RepoSetup fields draftIntent cares about (framework + structure.summary) —
 *  loosely typed here so this doesn't take a full @crawl-kit/behavior dependency
 *  just to read two strings out of repos/<name>.yaml. */
type RepoNoteSource = { framework?: string; structure?: { summary?: string } };

/** Read every `.crawl-kit/repos/*.yaml` (setup's per-repo config) into DraftInput's
 *  repoNotes shape. Missing/unreadable dir → no notes, not an error (draftGlossary
 *  still runs on whatever else is available). */
async function readRepoNotes(root: string): Promise<DraftInput["repoNotes"]> {
  const reposDir = crawlKitPath(root, "repos");
  let files: string[];
  try {
    files = (await readdir(reposDir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return [];
  }
  return Promise.all(
    files.map(async (file) => {
      const setup = await readYamlFile<RepoNoteSource>(join(reposDir, file)).catch(() => ({}) as RepoNoteSource);
      return {
        name: basename(file, extname(file)),
        framework: setup.framework ?? "generic",
        structureSummary: setup.structure?.summary ?? "",
      };
    }),
  );
}

/** Entity names from data/structure.rdra.json, when it exists (structure ran before intent). */
async function readEntityNames(root: string): Promise<string[] | undefined> {
  const rdra = await readJsonOr<{ entities?: Array<{ name: string }> }>(dataPath("structure.rdra.json", root), {});
  const names = rdra.entities?.map((e) => e.name) ?? [];
  return names.length > 0 ? names : undefined;
}

/** Top 50 route paths from data/structure.routes.partial.json (pass-1 partial), when it exists. */
async function readRouteSummaries(root: string): Promise<string[] | undefined> {
  const routes = await readJsonOr<Array<{ method: string; path: string }>>(
    dataPath(DATA_FILES.structureRoutesPartial, root),
    [],
  );
  const summaries = routes.slice(0, 50).map((r) => `${r.method.toUpperCase()} ${r.path}`);
  return summaries.length > 0 ? summaries : undefined;
}

async function buildDraftInput(root: string): Promise<DraftInput> {
  const [repoNotes, entityNames, routeSummaries] = await Promise.all([
    readRepoNotes(root),
    readEntityNames(root),
    readRouteSummaries(root),
  ]);
  return {
    repoNotes,
    ...(entityNames ? { entityNames } : {}),
    ...(routeSummaries ? { routeSummaries } : {}),
  };
}

/** `RunDeps.draftIntent` (P3 Task 4): no provider configured → null (intentPhase
 *  treats that as "auto-draft unavailable", not a failure). Otherwise assembles
 *  what's known about the workspace's repos/structure so far and asks the LLM
 *  for a first-pass Glossary. */
async function draftIntentForWorkspace(root: string): Promise<Glossary | null> {
  const provider = getProvider();
  if (!provider) return null;
  const input = await buildDraftInput(root);
  return draftGlossary(input, provider);
}

function buildRunDeps(): RunDeps {
  return {
    assetsDir: ASSETS_DIR,
    reconcile: () => cmdReconcile(),
    verify: () => cmdVerify(),
    analyzeStructureRepo: makeAnalyzeStructureRepo(),
    runBehavior: runBehaviorForWorkspace,
    draftIntent: draftIntentForWorkspace,
  };
}

async function cmdBehaviorPlan(args: string[]): Promise<void> {
  const ttl = Number(flag(args, "--ttl")) || DEFAULT_TTL_SECONDS;
  const store = { ...(await readStore(acquisitionPath(), ttl)), ttlSeconds: ttl };
  const structureNodes = await ingestOrEmpty(dataPath(DATA_FILES.structureNodes));
  const routes = structureNodes
    .filter((n) => n.nodeId.startsWith("structure:route/"))
    .map((n) => n.route ?? n.localName);
  if (routes.length === 0) {
    console.log("behavior-plan: structure に route がありません（先に analyze / reconcile）");
    return;
  }
  const plan = planBehaviorCrawl(routes, store, new Date());
  console.log(
    `behavior-plan: crawl ${plan.toCrawl.length} / skip ${plan.toSkip.length} / drop ${plan.toDrop.length}（TTL ${ttl}s）`,
  );
  for (const c of plan.toCrawl) console.log(`  crawl ${c.route}  (${c.reason})`);
  for (const r of plan.toDrop) console.log(`  drop  ${r}`);
  console.log("（loop-e2e はこの plan で crawl → 取得後に recordBehavior で鮮度更新）");
}

async function cmdDemo(): Promise<void> {
  console.log("demo: running the bundled sample (intent → structure → behavior → reconcile → verify)\n");
  await cmdIntent(join(SAMPLES, "intent.json"));
  await cmdStructureExtract(await readJson<StructureExtract>(join(SAMPLES, "structure.json")));
  // behavior is normally loop-e2e output; the demo ships a small observation
  await writeJson(dataPath(DATA_FILES.behaviorNodes), await readJson(join(SAMPLES, "behavior.nodes.json")));
  console.log("behavior: loaded bundled observation (3 node(s))");
  await cmdReconcile();
  await cmdVerify();
  console.log(`\nnext: 'npx @tanago3/crawl-kit serve' → http://localhost:4317 の「観測マップ」`);
}

async function ingestOrEmpty(path: string): Promise<LayerNode[]> {
  try {
    return await ingestLayerNodes(path);
  } catch {
    return [];
  }
}

const HELP = `crawl-kit — intent / structure / behavior が同じソフトウェアかを照らす

usage: crawl-kit <command>

  demo                 同梱サンプルで一連を実行（intent→structure→reconcile→verify）
  setup [dir]          ワークスペース初期化: git clone + .crawl-kit/ 生成（対話）
  doctor               プリフライト: distill-ddd / repo / DB / ログイン / target / playwright
  migrate [dir]        既存の e2e.config.yaml + data/ 運用をワークスペースへ移行
  run                  【ワークスペース内】統合コマンド: preflight→intent→structure→behavior→reconcile→verify を
                       一括実行し、ビューアを自動起動（--only intent|structure|behavior / --force / --no-viewer / --port N）
  run <repo>           【ワークスペース外・レガシー】analyze（structure+behavior）→ reconcile → verify（--ttl / --force / --target）
  clear [--phase intent|structure|behavior] [--all]
                       【ワークスペース内】フェーズ成果物と鮮度台帳をリセット（次の run で作り直す。--all で registry/decisions も）
  analyze <repo>       structure と behavior を両方取得（鮮度ゲート付き。--ttl <秒> / --force / --target）
  analyze-structure <repo>   静的解析のみ → data/structure.*.json
  analyze-behavior     loop-e2e で実クロール → data/behavior.nodes.json（要 e2e.config.yaml）
  intent <glossary>    intent.json を取り込み → data/intent.nodes.json
  reconcile            三層を正準IDで結合 → data/unified.json   (ADRS_PATH=... で ADR)
  verify               concept + 境界の検証 → data/*.findings.json
  check                reconcile → verify を一括実行
  behavior-plan        鮮度から crawl/skip/drop ページを算出（loop-e2e が使用。--ttl）
  serve [--port N]     ビューア起動（サイドバー「観測マップ」に統合）

behavior（実アプリのクロール観測）は loop-e2e 側。data/behavior.nodes.json があれば自動で取り込みます。`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "demo": return cmdDemo();
    case "setup": return cmdSetup(args);
    case "doctor": return cmdDoctor(args);
    case "migrate": return cmdMigrate(args);
    case "run": {
      const workspaceRoot = findWorkspaceRoot(process.cwd());
      if (workspaceRoot) return cmdRunWorkspace(args, buildRunDeps());
      const repoArg = args.find((a) => !a.startsWith("-"));
      if (repoArg) return cmdRun(args); // legacy repo-arg form, outside a workspace
      throw new Error(
        "crawl-kit run: ワークスペースも repo 引数も見つかりません。" +
          "'crawl-kit setup' でワークスペースを作成するか、'crawl-kit migrate' で既存の e2e.config.yaml/data 運用を移行してください" +
          "（あるいは 'crawl-kit run <repo>' のようにレガシー形式で repo を指定してください）。",
      );
    }
    case "clear": return cmdClear(args);
    case "analyze": return cmdAnalyze(args);
    case "analyze-structure": return cmdAnalyzeStructure(args);
    case "analyze-behavior": return cmdAnalyzeBehavior(args);
    case "intent": return cmdIntent(args[0]!);
    case "reconcile": return cmdReconcile();
    case "verify": return cmdVerify();
    case "check": return cmdCheck();
    case "behavior-plan": return cmdBehaviorPlan(args);
    case "serve": return cmdServe(args, ASSETS_DIR);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`crawl-kit: ${(error as Error).message}`);
  process.exit(1);
});
