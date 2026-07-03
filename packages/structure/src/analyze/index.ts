// packages/structure/src/analyze/index.ts
//
// The analysis pipeline, assembled exactly as rdra-analyzer's `analyze` command does:
//   SourceParser → UseCaseExtractor → InformationModelGenerator
// then projected onto crawl-kit's StructureExtract contract. One entry point,
// analyzeRepo(), runs the whole thing for a repo path. The LLM backend is resolved
// from the environment (USE_CLAUDE_CODE / ANTHROPIC_API_KEY); with none, every stage
// uses its deterministic fallback and the run completes offline.

import type { StructureExtract } from "../model.js";
import { buildContext, formatContextForPrompt } from "./context/project-context.js";
import { InformationModelGenerator, type Entity, type Relationship } from "./derived/information-model.js";
import { getProvider, type LlmProvider } from "./llm/provider.js";
import { extractDiffAxis } from "./scan.js";
import { SourceParser, type RepoParseResult } from "./source-parser.js";
import { toStructureExtract } from "./to-extract.js";
import { UseCaseExtractor, type UseCase } from "./usecase-extractor.js";

export interface AnalyzeOptions {
  /** override the auto-resolved provider (tests inject a fake; null forces fallbacks). */
  llm?: LlmProvider | null;
  /** cap the route count fed to usecase extraction (← rdra --max-routes, default 200). */
  maxRoutes?: number;
  /** skip the slow entity-operation pass (useful for structure-only reconciles). */
  skipEntityOperations?: boolean;
  /** skip the deterministic events/state-transitions scan (the diff axis). */
  skipDiffAxis?: boolean;
}

export interface AnalyzeRepoResult {
  extract: StructureExtract;
  parsed: RepoParseResult;
  entities: Entity[];
  relationships: Relationship[];
  usecases: UseCase[];
  provider: string;
}

export async function analyzeRepo(repoPath: string, options: AnalyzeOptions = {}): Promise<AnalyzeRepoResult> {
  const llm = options.llm !== undefined ? options.llm : getProvider();
  const context = formatContextForPrompt([buildContext(repoPath)]);

  const parser = new SourceParser(llm);
  const parsed = await parser.parseRepo(repoPath, { skipEntityOperations: options.skipEntityOperations });

  // cap routes before usecase extraction (← rdra default 200) to bound LLM batches
  const maxRoutes = options.maxRoutes ?? 200;
  const cappedRoutes = parsed.routes.slice(0, maxRoutes);

  const ucExtractor = new UseCaseExtractor(llm, context);
  const usecases = await ucExtractor.extract(cappedRoutes, parsed.controllers, parsed.models, parsed.pages);

  const infoGen = new InformationModelGenerator(llm, context);
  const { entities, relationships } = await infoGen.generate(parsed.models);

  // the diff axis (events + state transitions) is read deterministically from
  // source — no LLM — so it runs even in offline/fallback mode.
  const diffAxis = options.skipDiffAxis ? { events: [], stateTransitions: [] } : extractDiffAxis(repoPath);

  // route → events: trace each route's handler to the domain events it emits, name-matched
  // to the scanned event set. Needs the autonomous backend; returns {} otherwise.
  const routeEvents = await parser.extractRouteEvents(
    repoPath,
    context,
    cappedRoutes,
    diffAxis.events.map((e) => e.name),
  );

  const extract = toStructureExtract({
    routes: parsed.routes,
    models: parsed.models,
    entities,
    relationships,
    usecases,
    entityOperations: parsed.entityOperations,
    pages: parsed.pages,
    events: diffAxis.events,
    stateTransitions: diffAxis.stateTransitions,
    routeEvents,
  });

  return { extract, parsed, entities, relationships, usecases, provider: llm?.providerName ?? "none (fallback)" };
}

export {
  analyzeRepoIncremental,
  type IncrementalOptions,
  type IncrementalResult,
} from "./incremental.js";
export { runPasses, type RunPassesOpts, type RunPassesDeps, type RunPassesResult, type PassResult } from "./passes.js";
export { enumerateUnits, groupIntoUnits, type Unit, type RepoFile } from "./units.js";
export { mergeFragments, type MergedStructure } from "./merge.js";
export { parseUnit, type ParseUnitDeps } from "./scoped-parser.js";
export {
  emptyFragment,
  readFragment,
  writeFragment,
  fragmentFile,
  fragmentsCacheDir,
  type StructureFragment,
  type FragmentRef,
} from "./fragments.js";
export { SourceParser } from "./source-parser.js";
export { UseCaseExtractor } from "./usecase-extractor.js";
export { InformationModelGenerator } from "./derived/information-model.js";
export { toStructureExtract, type AnalysisResult } from "./to-extract.js";
export { extractEvents, extractStateTransitions, type SourceFile } from "./events.js";
export { readSourceFiles, extractDiffAxis, type DiffAxis } from "./scan.js";
export { buildContext, formatContextForPrompt, type ProjectContext } from "./context/project-context.js";
export { detectFrameworks, detectAndLoad } from "./context/knowledge.js";
export { getProvider, type LlmProvider } from "./llm/provider.js";
export type { ParsedRoute, ParsedModel, ParsedController, ParsedPage, EntityOperation } from "./source-parser.js";
export type { UseCase } from "./usecase-extractor.js";
export type { Entity, Relationship } from "./derived/information-model.js";
