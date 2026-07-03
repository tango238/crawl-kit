// packages/reconciler/src/index.ts
export { normalizeRoute } from "./match/route.js";
export {
  matchIntentToStructure,
  type MatchOptions,
  type IntentStructureResult,
} from "./match/intent-structure.js";
export { classifyUnmatchedEntity } from "./classify.js";
export { findViolations, findAdjudication } from "./adr.js";
export { priorHumanMatches, resolveDecisions, entityNodeId, type HumanDecision } from "./queue.js";
export {
  reconcile,
  type ReconcileInput,
  type ReconcileOptions,
  type ReconcileResult,
} from "./pipeline.js";
export { ingestLayerNodes } from "./ingest.js";
export {
  deriveAggregateEntityMapping,
  type AggregateDocLike,
  type AggregateDocEntryLike,
  type AggregateDocMemberLike,
  type AggregateEntityMapping,
} from "./aggregate-mapping.js";
