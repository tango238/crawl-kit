// packages/reconciler/src/queue.ts
//
// The reconciler is stateful by design: human judgement is burned into the registry
// so the SECOND run only asks about what changed (ADR-0007). The manual queue holds
// the genuinely-ambiguous same-as decisions (threshold gate failed); once a human
// decides, the decision lands in the registry as a `decidedBy: "human"` relation and
// is honoured forever after — never re-queued.

import type { Registry } from "@crawl-kit/contract";

const ENTITY_PREFIX = "structure:entity/";

/** entity node id for an entity name (the stable key human decisions hang off). */
export function entityNodeId(entityName: string): string {
  return `${ENTITY_PREFIX}${entityName}`;
}

/** A human's call on a queued item: "this entity IS that concept". */
export interface HumanDecision {
  entityName: string;
  conceptId: string;
  note?: string;
}

/** Human same-as decisions already in the registry: entity node id → concept id. */
export function priorHumanMatches(prior: Registry): Map<string, string> {
  const matches = new Map<string, string>();
  for (const rel of prior.relations) {
    if (rel.kind === "same-as" && rel.decidedBy === "human" && rel.from.startsWith(ENTITY_PREFIX)) {
      matches.set(rel.from, rel.to);
    }
  }
  return matches;
}

/** Merge prior burned-in matches with any fresh decisions from this run. */
export function resolveDecisions(
  prior: Registry,
  fresh: HumanDecision[],
): Map<string, { conceptId: string; note?: string }> {
  const resolved = new Map<string, { conceptId: string; note?: string }>();
  for (const [nodeId, conceptId] of priorHumanMatches(prior)) {
    resolved.set(nodeId, { conceptId });
  }
  for (const d of fresh) {
    resolved.set(entityNodeId(d.entityName), { conceptId: d.conceptId, note: d.note });
  }
  return resolved;
}
