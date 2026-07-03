// packages/reconciler/src/classify.ts
//
// ConceptState is the viewer's colour legend. This computes the BASE state (no ADRs
// yet — adr.ts overlays adjudicated / violates-decision on top). The whole design
// hinge lives here: before calling code-in-but-not-in-the-model an orphan, we look
// for `part-of` (it lives inside a matched aggregate) and for the below-the-line
// patterns. Most "scary" unmatched code is actually a calm aggregate-internal or
// implementation-detail. False positives are how a tool like this loses trust.

import type { ConceptState } from "@crawl-kit/contract";
import type { StructureEntity } from "./nodes.js";

/** Names that live "below the domain line": join/audit/session/outbox/cache/etc. */
const BELOW_THE_LINE = /(^|_)(sessions?|outbox|migrations?|audit|logs?|cache|jobs?|queue|events?|tokens?)($|_)/;

export interface EntityClassContext {
  /** matched entity name → concept id (from the intent↔structure matcher). */
  entityNameToConceptId: Map<string, string>;
  /** which matched concept ids are aggregate roots (eligible to OWN an internal). */
  aggregateRootConceptIds: Set<string>;
  /** entity names that are sitting in the manual queue (ambiguous match). */
  queuedEntityNames: Set<string>;
}

export interface EntityClassification {
  state: ConceptState;
  /** the aggregate root this entity is part-of, when state is aggregate-internal. */
  partOf?: string;
  /** the concept this technical entity serves, when implementation-detail. */
  serves?: string;
}

/**
 * Classify a structure entity that did NOT match an intent concept.
 *   queued            → unmatched (a human will decide the ambiguous same-as)
 *   part-of aggregate → aggregate-internal   (checked BEFORE crying orphan)
 *   below the line    → implementation-detail
 *   otherwise         → code-only            (a genuine leak)
 */
export function classifyUnmatchedEntity(
  entity: StructureEntity,
  ctx: EntityClassContext,
): EntityClassification {
  if (ctx.queuedEntityNames.has(entity.name)) {
    return { state: "unmatched" };
  }

  // part-of: does it depend on a matched aggregate root? (look here before "orphan")
  for (const dep of entity.dependsOn) {
    const depConceptId = ctx.entityNameToConceptId.get(dep);
    if (depConceptId && ctx.aggregateRootConceptIds.has(depConceptId)) {
      return { state: "aggregate-internal", partOf: depConceptId };
    }
  }

  if (BELOW_THE_LINE.test(entity.name)) {
    // it serves a depended-on domain concept when there is one, else the domain at large
    const served = entity.dependsOn
      .map((d) => ctx.entityNameToConceptId.get(d))
      .find((id): id is string => Boolean(id));
    return { state: "implementation-detail", serves: served };
  }

  return { state: "code-only" };
}
