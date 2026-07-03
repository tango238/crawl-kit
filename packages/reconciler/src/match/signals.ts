// packages/reconciler/src/match/signals.ts
//
// The deterministic evidence signals, computed BEFORE any LLM is consulted. Each
// returns a piece of the Evidence vector — never a single blended score, because a
// human can act on "same attributes, different name" but not on "0.82 similar".
//   name       — weak & noisy on intent↔structure (glossary term vs code name)
//   attributes — structurally the strongest signal (same fields ⇒ same thing)
//   topology   — do the relationships line up on both sides
//   behavior   — do the same kinds of operations touch it

import type { Evidence } from "@crawl-kit/contract";
import type { IntentConcept, StructureEntity } from "../nodes.js";
import { jaccard, normalizeAttr, normalizeName } from "./normalize.js";

export function nameSignal(concept: IntentConcept, entity: StructureEntity): Evidence["name"] {
  const entityKey = normalizeName(entity.name);
  const candidates = [concept.canonicalName, ...concept.aliases].map(normalizeName);
  let best = 0;
  for (const cand of candidates) {
    if (cand === entityKey) {
      best = 1;
      break;
    }
    const a = new Set(cand.split(" "));
    const b = new Set(entityKey.split(" "));
    best = Math.max(best, jaccard(a, b));
  }
  return { score: round(best), note: `"${concept.canonicalName}" vs "${entity.name}"` };
}

export function attributesSignal(
  concept: IntentConcept,
  entity: StructureEntity,
): Evidence["attributes"] {
  const conceptKeys = new Map(concept.attributes.map((a) => [normalizeAttr(a), a]));
  const entityKeys = new Map(entity.attributes.map((a) => [normalizeAttr(a), a]));
  const shared: string[] = [];
  for (const [key, original] of conceptKeys) {
    if (entityKeys.has(key)) shared.push(original);
  }
  const score = jaccard(new Set(conceptKeys.keys()), new Set(entityKeys.keys()));
  return { score: round(score), shared };
}

/**
 * Topology: of the concepts this entity depends on (resolved via the provisional
 * entity→concept map), how many does the intent concept also declare a dependency
 * on. Corroborating, not decisive.
 */
export function topologySignal(
  concept: IntentConcept,
  entity: StructureEntity,
  entityNameToConceptId: Map<string, string>,
  conceptNameToId: Map<string, string>,
): Evidence["topology"] {
  const entityDepIds = new Set(
    entity.dependsOn.map((n) => entityNameToConceptId.get(n)).filter((x): x is string => Boolean(x)),
  );
  const conceptDepIds = new Set(
    concept.dependsOn.map((n) => conceptNameToId.get(normalizeName(n))).filter((x): x is string => Boolean(x)),
  );
  if (entityDepIds.size === 0 && conceptDepIds.size === 0) {
    return { score: 0, note: "no dependencies on either side" };
  }
  const score = jaccard(entityDepIds, conceptDepIds);
  return { score: round(score), note: `${entityDepIds.size}↔${conceptDepIds.size} deps` };
}

export function behaviorSignal(
  concept: IntentConcept,
  entity: StructureEntity,
): Evidence["behavior"] {
  const domainKind = concept.kind === "aggregate-root" || concept.kind === "entity";
  const touched = entity.crud.length > 0;
  const score = domainKind && touched ? 0.5 : 0;
  return { score, note: touched ? `CRUD ${entity.crud.join("")}` : "no operations" };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
