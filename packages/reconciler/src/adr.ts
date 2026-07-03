// packages/reconciler/src/adr.ts
//
// The ADR overlay — the adjudicator that rides ON the edges. The DDD model is a
// snapshot with no "why/when"; the ADR is the time + causal layer. Without it,
// "intent ≠ structure" can't tell a bug from a model that's merely behind a
// decision already made. Two computable outcomes:
//
//   violates-decision — an ADR `forbid-dependency` (or unmet `require-dependency`)
//                        is broken by the structure topology. The headline finding:
//                        computed from the graph + the record, not waiting for prod.
//   adjudicated       — a divergence an accepted ADR EXPLAINS (a `note` whose `from`
//                        concept this code hangs off). Not a defect — the model
//                        catching up to a decision.

import type { Adr, AdrId, ConceptId } from "@crawl-kit/contract";

function accepted(adrs: Adr[]): Adr[] {
  return adrs.filter((a) => a.status === "accepted");
}

export interface Violation {
  conceptId: ConceptId;
  adrId: AdrId;
  detail: string;
}

/**
 * Compute forbid/require violations against the structure dependency graph.
 * `structureDeps`: concept id → set of concept ids it (its entity) depends on.
 */
export function findViolations(
  adrs: Adr[],
  structureDeps: Map<ConceptId, Set<ConceptId>>,
): Map<ConceptId, Violation> {
  const violations = new Map<ConceptId, Violation>();
  for (const adr of accepted(adrs)) {
    for (const c of adr.constraints) {
      if (!c.from || !c.to) continue;
      const deps = structureDeps.get(c.from) ?? new Set<ConceptId>();
      if (c.kind === "forbid-dependency" && deps.has(c.to)) {
        violations.set(c.from, { conceptId: c.from, adrId: adr.adrId, detail: c.text });
      }
      if (c.kind === "require-dependency" && !deps.has(c.to)) {
        violations.set(c.from, {
          conceptId: c.from,
          adrId: adr.adrId,
          detail: `required dependency missing: ${c.text}`,
        });
      }
    }
  }
  return violations;
}

/**
 * Find which ADR (if any) adjudicates an entity-concept's divergence: an accepted
 * ADR with a `note` constraint whose `from` concept this entity hangs off (depends on).
 * `dependsOnConcepts`: the concept ids the entity-concept depends on.
 */
export function findAdjudication(
  adrs: Adr[],
  dependsOnConcepts: Set<ConceptId>,
): { adrId: AdrId; detail: string } | undefined {
  for (const adr of accepted(adrs)) {
    for (const c of adr.constraints) {
      if (c.kind === "note" && c.from && dependsOnConcepts.has(c.from)) {
        return { adrId: adr.adrId, detail: c.text };
      }
    }
  }
  return undefined;
}
