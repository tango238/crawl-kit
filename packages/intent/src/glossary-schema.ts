// packages/intent/src/glossary-schema.ts
//
// zod mirror of model.ts's Glossary shape. Used to validate LLM-drafted
// glossaries (draft.ts) before they're trusted as intent input — an LLM
// response is untyped text until it passes this gate. Kept structurally
// identical to model.ts: concepts[].name/attributes required, everything
// else optional. Not `.strict()` — an LLM may emit harmless extra keys
// (e.g. a stray "description") that we'd rather ignore than reject.

import { z } from "zod";

const conceptKindSchema = z.enum([
  "aggregate-root",
  "entity",
  "value-object",
  "service",
  "policy",
]);

const glossaryConceptSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  kind: conceptKindSchema.nullable().optional(),
  context: z.string().optional(),
  attributes: z.array(z.string()),
  dependsOn: z.array(z.string()).optional(),
});

const glossaryEventSchema = z.object({
  name: z.string(),
  aggregate: z.string().optional(),
  context: z.string().optional(),
  trigger: z.string().optional(),
  properties: z.array(z.string()).optional(),
  consumer: z.string().optional(),
});

const glossaryStateTransitionSchema = z.object({
  aggregate: z.string(),
  context: z.string().optional(),
  from: z.string(),
  to: z.string(),
  trigger: z.string().nullable().optional(),
  event: z.string().nullable().optional(),
});

export const GlossarySchema = z.object({
  concepts: z.array(glossaryConceptSchema),
  events: z.array(glossaryEventSchema).optional(),
  stateTransitions: z.array(glossaryStateTransitionSchema).optional(),
});
