// packages/intent/src/aggregates.ts
//
// Derive the aggregate roster from the glossary: every aggregate-root concept,
// plus the concepts whose dependsOn names it. Pure and silent — no I/O, no
// console output. conceptId minting reuses emit.ts's canonicalId rule so ids
// line up with the intent nodes emitted from the same glossary.

import { canonicalId } from "./emit.js";
import type { Glossary } from "./model.js";

/**
 * How a concept ended up inside an aggregate's members list. "self" is the
 * aggregate root itself; "dependsOn" is a concept that names the aggregate in
 * its `dependsOn`. "event" is reserved for a future event-sourced membership
 * rule and is not produced by `deriveAggregates` yet.
 */
export interface AggregateMember {
  conceptId: string;
  name: string;
  via: "dependsOn" | "event" | "self";
}

export interface AggregateEntry {
  conceptId: string;
  name: string;
  members: AggregateMember[];
}

export interface AggregateDoc {
  aggregates: AggregateEntry[];
}

/**
 * Pure derivation of the aggregate roster from a glossary. An aggregate is any
 * concept with `kind === "aggregate-root"`. Its members are itself (via
 * "self") plus every other concept whose `dependsOn` includes the aggregate's
 * name (via "dependsOn"); dependsOn entries that don't resolve to a known
 * concept are silently ignored.
 */
export function deriveAggregates(glossary: Glossary): AggregateDoc {
  const roots = glossary.concepts.filter((concept) => concept.kind === "aggregate-root");

  const aggregates = roots.map((root) => {
    const rootConceptId = canonicalId(root);
    const dependents = glossary.concepts
      .filter((concept) => concept !== root && (concept.dependsOn ?? []).includes(root.name))
      .map((concept) => ({
        conceptId: canonicalId(concept),
        name: concept.name,
        via: "dependsOn" as const,
      }));

    return {
      conceptId: rootConceptId,
      name: root.name,
      members: [{ conceptId: rootConceptId, name: root.name, via: "self" as const }, ...dependents],
    };
  });

  return { aggregates };
}
