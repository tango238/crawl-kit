// packages/structure/src/analyze/incremental.ts
//
// Task 6 of the incremental/distributed analyzer: the drop-in analysis entry that runs on
// the pass/fan-out/diff engine instead of the whole-repo SourceParser. analyzeRepo (legacy,
// index.ts) is left untouched — this is the parallel path the CLI opts into with
// --incremental. Pass 1 yields a routes-only StructureExtract usable immediately by e2e/CRUD
// planning; passes 2/3 enrich it. The same toStructureExtract projection is used, so
// downstream (emit → LayerNode → reconciler) is unchanged.

import type { StructureExtract } from "../model.js";
import { buildContext, formatContextForPrompt } from "./context/project-context.js";
import { InformationModelGenerator, type Entity, type Relationship } from "./derived/information-model.js";
import { getProvider, type LlmProvider } from "./llm/provider.js";
import type { MergedStructure } from "./merge.js";
import { runPasses, type PassResult, type RunPassesDeps } from "./passes.js";
import { extractDiffAxis } from "./scan.js";
import type { EntityOperation, ParsedController } from "./source-parser.js";
import { toStructureExtract } from "./to-extract.js";
import { UseCaseExtractor, type UseCase } from "./usecase-extractor.js";
import type { Unit } from "./units.js";

export interface IncrementalOptions {
  /** override the auto-resolved provider (tests inject a fake; null forces fallbacks). */
  llm?: LlmProvider | null;
  /** which passes to run, in order (default [1, 2, 3]). */
  passes?: number[];
  /** ignore the fragment cache and re-parse every unit. */
  force?: boolean;
  /** fragment cache directory (default <repo>/.crawl-kit-cache). */
  cacheDir?: string;
  /** override unit enumeration (tests inject a fixed set). */
  enumerate?: (repoPath: string) => Unit[];
  /** override the per-unit parser (tests inject a fake). */
  parse?: RunPassesDeps["parse"];
  /** cap routes fed to usecase extraction (← rdra default 200). */
  maxRoutes?: number;
  /** skip the deterministic events/state-transitions scan. */
  skipDiffAxis?: boolean;
  /** progressive emit: called after each pass with the current StructureExtract projection. */
  onPass?: (pass: number, extract: StructureExtract, merged: MergedStructure) => void | Promise<void>;
  /** per-unit progress: called once per unit per pass when that unit's fragment is finalized (cache hit or fresh parse). */
  onUnit?: RunPassesDeps["onUnit"];
}

export interface IncrementalResult {
  extract: StructureExtract;
  merged: MergedStructure;
  /** the pass-1 routes-only projection (available before detail passes). */
  routesPartial: StructureExtract;
  passes: PassResult[];
  entities: Entity[];
  relationships: Relationship[];
  usecases: UseCase[];
  provider: string;
}

/** Analyze a repo through the incremental pass engine, emitting progressively per pass. */
export async function analyzeRepoIncremental(
  repoPath: string,
  options: IncrementalOptions = {},
): Promise<IncrementalResult> {
  const llm = options.llm !== undefined ? options.llm : getProvider();
  const context = formatContextForPrompt([buildContext(repoPath)]);
  const passes = options.passes ?? [1, 2, 3];

  let routesPartial: StructureExtract = toStructureExtract(emptyAnalysis());
  type Detailed = Awaited<ReturnType<typeof projectFullDetailed>>;
  let lastDetailed: Detailed | null = null;

  const passResults = await runPasses(
    repoPath,
    { passes, force: options.force, context },
    {
      llm,
      enumerate: options.enumerate,
      parse: options.parse,
      cacheDir: options.cacheDir,
      onUnit: options.onUnit,
      onPass: async (pass, merged) => {
        // pass 1 is a route inventory — project routes only so planning can start now.
        // passes ≥ 2 do the full projection once; the last one is reused as the return value.
        let extract: StructureExtract;
        if (pass === 1) {
          extract = toStructureExtract({ ...emptyAnalysis(), routes: merged.routes });
          routesPartial = extract;
          if (lastDetailed === null) lastDetailed = { extract, entities: [], relationships: [], usecases: [] };
        } else {
          lastDetailed = await projectFullDetailed(repoPath, context, llm, merged, options);
          extract = lastDetailed.extract;
        }
        await options.onPass?.(pass, extract, merged);
      },
    },
  );

  const finalMerged = passResults.passes[passResults.passes.length - 1]?.merged ?? emptyMerged();
  // reuse the last pass's projection; fall back to projecting the final merge if no pass ran.
  const detailed = lastDetailed ?? (await projectFullDetailed(repoPath, context, llm, finalMerged, options));

  return {
    extract: detailed.extract,
    merged: finalMerged,
    routesPartial,
    passes: passResults.passes,
    entities: detailed.entities,
    relationships: detailed.relationships,
    usecases: detailed.usecases,
    provider: llm?.providerName ?? "none (fallback)",
  };
}

/** Project a merged structure into a full StructureExtract (entities + usecases + diff axis). */
async function projectFullDetailed(
  repoPath: string,
  context: string,
  llm: LlmProvider | null,
  merged: MergedStructure,
  options: IncrementalOptions,
): Promise<{ extract: StructureExtract; entities: Entity[]; relationships: Relationship[]; usecases: UseCase[] }> {
  const maxRoutes = options.maxRoutes ?? 200;
  const cappedRoutes = merged.routes.slice(0, maxRoutes);

  const infoGen = new InformationModelGenerator(llm, context);
  const { entities, relationships } = await infoGen.generate(merged.models);

  const ucExtractor = new UseCaseExtractor(llm, context);
  const usecases = await ucExtractor.extract(cappedRoutes, merged.controllers, merged.models, []);

  const diffAxis = options.skipDiffAxis
    ? { events: [], stateTransitions: [] }
    : extractDiffAxis(repoPath);

  const extract = toStructureExtract({
    routes: merged.routes,
    models: merged.models,
    entities,
    relationships,
    usecases,
    entityOperations: flattenEntityOps(merged.controllers),
    pages: [],
    events: diffAxis.events,
    stateTransitions: diffAxis.stateTransitions,
  });

  return { extract, entities, relationships, usecases };
}

/** Flatten controller entityOperations (method → ops) into a flat list for the extract. */
function flattenEntityOps(controllers: ParsedController[]): EntityOperation[] {
  const out: EntityOperation[] = [];
  for (const c of controllers) for (const ops of Object.values(c.entityOperations)) out.push(...ops);
  return out;
}

function emptyMerged(): MergedStructure {
  return { routes: [], controllers: [], models: [], refs: [] };
}

function emptyAnalysis(): Parameters<typeof toStructureExtract>[0] {
  return { routes: [], models: [], entities: [], relationships: [], usecases: [] };
}
