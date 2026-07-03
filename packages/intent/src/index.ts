// packages/intent/src/index.ts
export type {
  Glossary,
  GlossaryConcept,
  GlossaryEvent,
  GlossaryStateTransition,
  ConceptKind,
} from "./model.js";
export {
  emitIntentNodes,
  emitConceptNodes,
  emitEventNodes,
  emitStateTransitionNodes,
  canonicalId,
  slugify,
} from "./emit.js";
export type { AggregateDoc, AggregateEntry, AggregateMember } from "./aggregates.js";
export { deriveAggregates } from "./aggregates.js";
export { GlossarySchema } from "./glossary-schema.js";
export type { DraftInput, DraftLlm } from "./draft.js";
export { draftGlossary } from "./draft.js";
