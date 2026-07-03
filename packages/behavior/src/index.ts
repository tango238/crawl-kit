// packages/behavior/src/index.ts
//
// Public API of the behavior layer (loop-e2e absorbed). The crawl/verify pipeline runs
// via the `loop-e2e` CLI (src/cli); the spine-facing boundary is the contract emit.

export { emitBehaviorNodes, emitBehaviorTransitionNodes, emitTransactionNodes, emitBehaviorAll } from './emit.js'
export type {
  SiteStructure,
  PageInfo,
  Report,
  DiffFinding,
  VerifyFinding,
  FindingVerdict,
  RefuterVote,
  Feedback,
  Scenario,
} from './domain/types.js'

export {
  WorkspaceConfigSchema,
  RepoSetupSchema,
  WORKSPACE_CONFIG_RELPATH,
} from './config/schema.js'
export type { WorkspaceConfig, WorkspaceRepository, RepoSetup } from './config/schema.js'
export { loadWorkspaceConfig } from './config/load.js'
export { createDbAdapter } from './services/db/index.js'
