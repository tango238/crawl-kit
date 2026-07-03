// packages/reconciler/src/match/intent-structure.ts
//
// The intent↔structure matcher. Deterministic signals decide the confident cases;
// only the ambiguous gray band ("same-ish attributes, different name") is handed to
// the LLM, and even then it arrives WITH the structural evidence. Everything is folded
// into ADR-0007's two knobs: `direction` (which way to lean) and `threshold` (above →
// auto, below → manual queue).

import type { Evidence } from "@crawl-kit/contract";
import type { IntentConcept, StructureEntity } from "../nodes.js";
import { normalizeName } from "./normalize.js";
import { attributesSignal, behaviorSignal, nameSignal, topologySignal } from "./signals.js";
import { ABSTAIN, type LlmJudge } from "./llm.js";

export interface MatchOptions {
  /** above this composite (and the gate) → auto-accept; below → consider the queue. */
  threshold?: number;
  /** ambiguous floor: a non-gated match with attributes ≥ this goes to the queue. */
  grayFloor?: number;
  /** which layer wins when auto-resolving. (Recorded; affects canonical naming in M5.) */
  direction?: "intent" | "code";
  judge?: LlmJudge;
}

export interface AcceptedMatch {
  conceptId: string;
  entity: StructureEntity;
  evidence: Evidence;
  composite: number;
  via: "deterministic" | "llm";
}

export interface QueuedMatch {
  entity: StructureEntity;
  bestConceptId: string;
  evidence: Evidence;
  composite: number;
}

export interface IntentStructureResult {
  accepted: AcceptedMatch[];
  queued: QueuedMatch[];
  /** matched entity name → concept id (used to resolve topology + behavior linkage). */
  entityNameToConceptId: Map<string, string>;
}

const WEIGHTS = { attributes: 0.45, name: 0.25, topology: 0.2, behavior: 0.1 };

function composite(e: Evidence): number {
  return (
    WEIGHTS.attributes * (e.attributes?.score ?? 0) +
    WEIGHTS.name * (e.name?.score ?? 0) +
    WEIGHTS.topology * (e.topology?.score ?? 0) +
    WEIGHTS.behavior * (e.behavior?.score ?? 0)
  );
}

/** The deterministic auto-accept gate: strong attributes alone, or solid attributes + name. */
function gated(e: Evidence): boolean {
  const attr = e.attributes?.score ?? 0;
  const name = e.name?.score ?? 0;
  return attr >= 0.8 || (attr >= 0.5 && name >= 0.5);
}

function conceptNameIndex(concepts: IntentConcept[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const c of concepts) {
    index.set(normalizeName(c.canonicalName), c.conceptId);
    for (const alias of c.aliases) index.set(normalizeName(alias), c.conceptId);
  }
  return index;
}

export async function matchIntentToStructure(
  concepts: IntentConcept[],
  entities: StructureEntity[],
  options: MatchOptions = {},
): Promise<IntentStructureResult> {
  const grayFloor = options.grayFloor ?? 0.5;
  const judge = options.judge ?? ABSTAIN;
  const conceptNameToId = conceptNameIndex(concepts);

  // Pass A — provisional map from attributes+name only, to ground topology in pass B.
  const provisional = new Map<string, string>();
  for (const entity of entities) {
    let best: { id: string; e: Evidence } | undefined;
    for (const c of concepts) {
      const e: Evidence = { name: nameSignal(c, entity), attributes: attributesSignal(c, entity) };
      if (!best || (e.attributes?.score ?? 0) > (best.e.attributes?.score ?? 0)) {
        best = { id: c.conceptId, e };
      }
    }
    if (best && gated(best.e)) provisional.set(entity.name, best.id);
  }

  // Pass B — full evidence vector (with topology), decide accept / queue / no-match.
  const accepted: AcceptedMatch[] = [];
  const queued: QueuedMatch[] = [];
  const entityNameToConceptId = new Map<string, string>();

  for (const entity of entities) {
    let best: { c: IntentConcept; e: Evidence; score: number } | undefined;
    for (const c of concepts) {
      const e: Evidence = {
        name: nameSignal(c, entity),
        attributes: attributesSignal(c, entity),
        topology: topologySignal(c, entity, provisional, conceptNameToId),
        behavior: behaviorSignal(c, entity),
      };
      const score = composite(e);
      if (!best || score > best.score) best = { c, e, score };
    }
    if (!best) continue;

    if (gated(best.e)) {
      accepted.push({ conceptId: best.c.conceptId, entity, evidence: best.e, composite: round(best.score), via: "deterministic" });
      entityNameToConceptId.set(entity.name, best.c.conceptId);
      continue;
    }

    if ((best.e.attributes?.score ?? 0) >= grayFloor) {
      // ambiguous — give the LLM the structural evidence; abstention keeps it queued.
      const verdict = await judge.judge(best.c, entity, best.e);
      if (verdict && verdict.score >= (options.threshold ?? 0.5)) {
        const evidence = { ...best.e, llm: verdict };
        accepted.push({ conceptId: best.c.conceptId, entity, evidence, composite: round(composite(evidence)), via: "llm" });
        entityNameToConceptId.set(entity.name, best.c.conceptId);
      } else {
        queued.push({ entity, bestConceptId: best.c.conceptId, evidence: best.e, composite: round(best.score) });
      }
    }
    // else: no plausible intent match — left for classify (part-of / impl-detail / code-only).
  }

  return { accepted, queued, entityNameToConceptId };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
