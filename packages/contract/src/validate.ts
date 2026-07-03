// packages/contract/src/validate.ts
//
// Referential integrity for the spine. The registry is the one durable file every
// tool reads; if it carries a dangling conceptId/adrId, every downstream join is a
// lie. So validation is a GATE, not a linter: io.ts refuses to write anything that
// does not pass. This promotes loop-e2e's "always referentially valid, abort on a
// failed check" guarantee to the shared contract.

import { z } from "zod";
import type { Registry, Unified } from "./model.js";

// ---------------------------------------------------------------------------
// Shape schemas — mirror model.ts. Catch malformed payloads before we ever try
// to resolve a reference. Kept structural; the referential checks come after.
// ---------------------------------------------------------------------------

const layer = z.enum(["intent", "structure", "behavior"]);

const conceptState = z.enum([
  "aligned",
  "intent-only",
  "code-only",
  "aggregate-internal",
  "implementation-detail",
  "adjudicated",
  "violates-decision",
  "unmatched",
]);

const evidence = z
  .object({
    name: z.object({ score: z.number(), note: z.string().optional() }).optional(),
    attributes: z.object({ score: z.number(), shared: z.array(z.string()) }).optional(),
    topology: z.object({ score: z.number(), note: z.string().optional() }).optional(),
    behavior: z.object({ score: z.number(), note: z.string().optional() }).optional(),
    llm: z
      .object({ score: z.number(), rationale: z.string(), model: z.string() })
      .optional(),
  })
  .strict();

const relation = z
  .object({
    kind: z.enum(["same-as", "part-of", "serves", "derived-from"]),
    from: z.string(),
    to: z.string(),
    evidence: evidence.optional(),
    decidedBy: z.enum(["auto", "human"]),
    decidedAt: z.string(),
  })
  .strict();

const adrConstraint = z
  .object({
    kind: z.enum(["forbid-dependency", "require-dependency", "note"]),
    from: z.string().optional(),
    to: z.string().optional(),
    text: z.string(),
  })
  .strict();

const adr = z
  .object({
    adrId: z.string(),
    title: z.string(),
    status: z.enum(["proposed", "accepted", "superseded", "deprecated"]),
    date: z.string(),
    affects: z.array(z.string()),
    constraints: z.array(adrConstraint),
    supersedes: z.string().optional(),
  })
  .strict();

const concept = z
  .object({
    conceptId: z.string(),
    canonicalName: z.string(),
    aliases: z.array(z.string()),
    kind: z
      .enum(["aggregate-root", "entity", "value-object", "service", "policy"])
      .optional(),
    nodes: z.record(layer, z.array(z.string())),
    state: conceptState,
    decisions: z.array(z.string()),
    resolution: z
      .object({
        decidedBy: z.enum(["auto", "human"]),
        note: z.string().optional(),
        decidedAt: z.string(),
      })
      .optional(),
  })
  .strict();

export const registrySchema = z
  .object({
    version: z.literal(1),
    concepts: z.record(z.string(), concept),
    adrs: z.record(z.string(), adr),
    relations: z.array(relation),
  })
  .strict();

const layerNode = z
  .object({
    nodeId: z.string(),
    layer,
    localName: z.string(),
    raw: z.unknown(),
    route: z.string().optional(),
    source: z.object({
      tool: z.enum(["distill-ddd", "rdra-analyzer", "loop-e2e"]),
      runId: z.string().optional(),
    }),
    persisted: z.enum(["yes", "no", "unknown"]).optional(),
  })
  .strict();

const unifiedConcept = z
  .object({
    conceptId: z.string(),
    canonicalName: z.string(),
    state: conceptState,
    intent: layerNode.optional(),
    structure: z.array(layerNode).optional(),
    behavior: z.array(layerNode).optional(),
    decisions: z.array(adr),
    divergences: z.array(
      z
        .object({
          edge: z.enum(["intent↔structure", "structure↔behavior", "intent↔behavior"]),
          detail: z.string(),
          adjudicatedBy: z.string().optional(),
          violates: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const unifiedSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string(),
    concepts: z.array(unifiedConcept),
  })
  .strict();

// ---------------------------------------------------------------------------
// Validation error — collects EVERY problem, not just the first. A half-fixed
// registry is as broken as a fully broken one; the writer wants the whole list.
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`registry failed validation:\n  - ${issues.join("\n  - ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

const CONCEPT_PREFIX = "concept:";
const ADR_PREFIX = "adr:";

/** Referential checks beyond shape: no conceptId/adrId may dangle. */
function referentialIssues(registry: Registry): string[] {
  const issues: string[] = [];
  const conceptIds = new Set(Object.keys(registry.concepts));
  const adrIds = new Set(Object.keys(registry.adrs));

  for (const [key, c] of Object.entries(registry.concepts)) {
    if (c.conceptId !== key) {
      issues.push(`concept key "${key}" does not match its conceptId "${c.conceptId}"`);
    }
    for (const adrId of c.decisions) {
      if (!adrIds.has(adrId)) {
        issues.push(`concept "${key}" references unknown ADR "${adrId}"`);
      }
    }
  }

  for (const [key, a] of Object.entries(registry.adrs)) {
    if (a.adrId !== key) {
      issues.push(`adr key "${key}" does not match its adrId "${a.adrId}"`);
    }
    for (const conceptId of a.affects) {
      if (!conceptIds.has(conceptId)) {
        issues.push(`adr "${key}" affects unknown concept "${conceptId}"`);
      }
    }
    if (a.supersedes && !adrIds.has(a.supersedes)) {
      issues.push(`adr "${key}" supersedes unknown ADR "${a.supersedes}"`);
    }
    for (const constraint of a.constraints) {
      for (const endpoint of [constraint.from, constraint.to]) {
        if (endpoint && !conceptIds.has(endpoint)) {
          issues.push(`adr "${key}" constraint references unknown concept "${endpoint}"`);
        }
      }
    }
  }

  registry.relations.forEach((rel, i) => {
    for (const endpoint of [rel.from, rel.to]) {
      // Endpoints are ConceptId | NodeId. We can only resolve the concept-shaped
      // ones against the registry; NodeIds resolve against the layer emits.
      if (endpoint.startsWith(CONCEPT_PREFIX) && !conceptIds.has(endpoint)) {
        issues.push(`relation[${i}] references unknown concept "${endpoint}"`);
      }
      if (endpoint.startsWith(ADR_PREFIX)) {
        issues.push(`relation[${i}] endpoint "${endpoint}" is an ADR — relations link concepts/nodes, not decisions`);
      }
    }
  });

  return issues;
}

/**
 * Validate a registry: structural shape THEN referential integrity.
 * Throws {@link ValidationError} with every issue found. Never mutates.
 */
export function validateRegistry(registry: Registry): Registry {
  const parsed = registrySchema.safeParse(registry);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`));
  }
  const issues = referentialIssues(registry);
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return registry;
}

/** Validate a derived unified view (shape only — it embeds resolved copies). */
export function validateUnified(unified: Unified): Unified {
  const parsed = unifiedSchema.safeParse(unified);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`));
  }
  return unified;
}
