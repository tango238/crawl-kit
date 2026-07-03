// packages/contract/src/index.ts
//
// The public face of the spine. Every other package imports from here and here only.

export * from "./model.js";
export {
  ValidationError,
  validateRegistry,
  validateUnified,
  registrySchema,
  unifiedSchema,
} from "./validate.js";
export {
  emptyRegistry,
  readRegistry,
  readRegistryOrEmpty,
  writeRegistry,
  readUnified,
  writeUnified,
  readJsonFile,
  readJsonFileOr,
  writeJsonAtomic,
} from "./io.js";
export { findRepoRoot, dataPath, DATA_FILES } from "./paths.js";
export {
  CRAWL_KIT_DIR,
  WORKSPACE_FILES,
  findWorkspaceRoot,
  resolveRoot,
  crawlKitPath,
  workspaceConfigPath,
  progressPath,
  repoConfigPath,
} from "./workspace.js";
export {
  makeLimiter,
  resolveClaudeCodeConcurrency,
  DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY,
  CLAUDE_CODE_MAX_CONCURRENCY_ENV,
  type Limiter,
} from "./concurrency.js";
export {
  PHASE_NAMES,
  emptyProgress,
  withPhaseStatus,
  withTasksRegistered,
  withTaskCompleted,
  readProgressOrEmpty,
  writeProgress,
  type PhaseName,
  type PhaseStatus,
  type PhaseProgress,
  type Progress,
} from "./progress.js";
export { normalizeRoute } from "./route.js";
