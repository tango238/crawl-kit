// packages/structure/src/index.ts
export type {
  Crud,
  RouteRecord,
  EntityRecord,
  UsecaseRecord,
  EntityOperation,
  StructureEvent,
  StructureStateTransition,
  StructureExtract,
} from "./model.js";
export {
  buildInformationModel,
  type InformationModel,
  type EntityNode,
} from "./information-model.js";
export { buildCrudIndex, entityCrud, normalizeEntityKey } from "./crud.js";
export { entityRelationshipDiagram, usecaseDiagram } from "./rdra/diagrams.js";
export { analyzeCrud, type CrudReport, type CrudGap } from "./gap/crud.js";
export {
  buildRdraArtifacts,
  type RdraArtifacts,
  type RdraModel,
  type RdraEntity,
  type RdraUsecase,
} from "./rdra/artifacts.js";
export { emitStructureNodes, type EmitOptions } from "./emit.js";
export { applyCorrections, type Correction, type ApplyResult } from "./corrections.js";
export {
  loadCorrections,
  saveCorrections,
  writeStructureOutputs,
  reportCorrections,
  CORRECTIONS_FILE,
} from "./outputs.js";
export { investigateEntity, type Investigation } from "./analyze/investigate.js";
export {
  analyzeRepo,
  type AnalyzeRepoResult,
  type AnalyzeOptions,
  analyzeRepoIncremental,
  type IncrementalOptions,
  type IncrementalResult,
  enumerateUnits,
  groupIntoUnits,
  type Unit,
  type RepoFile,
  mergeFragments,
  type MergedStructure,
  runPasses,
  type RunPassesOpts,
  type RunPassesDeps,
  SourceParser,
  UseCaseExtractor,
  InformationModelGenerator,
  toStructureExtract,
  buildContext,
  formatContextForPrompt,
  detectFrameworks,
  getProvider,
  extractEvents,
  extractStateTransitions,
  extractDiffAxis,
  readSourceFiles,
  type SourceFile,
  type DiffAxis,
} from "./analyze/index.js";
