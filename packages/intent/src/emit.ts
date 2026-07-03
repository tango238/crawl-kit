// packages/intent/src/emit.ts
//
// Turn glossary concepts, events, and state transitions into intent LayerNodes.
// Each concept node carries the canonical id it mints (in raw.conceptId) so the
// reconciler can seed the registry from intent — the glossary is where ids are
// born, every other layer joins onto them. Event and transition nodes reference
// their owning aggregate's conceptId so they hang off the same spine.

import type { LayerNode } from "@crawl-kit/contract";
import type {
  Glossary,
  GlossaryConcept,
  GlossaryEvent,
  GlossaryStateTransition,
} from "./model.js";

const TOOL = "distill-ddd" as const;

/** kebab slug: "Loyalty Tier" → "loyalty-tier", "∅" → "" (no ascii word chars). */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "concept:order" from { name: "Order" }, or the explicit id when given. */
export function canonicalId(concept: GlossaryConcept): string {
  return concept.id ?? `concept:${slugify(concept.name)}`;
}

/** "concept:order" from a bare aggregate name. */
function aggregateConceptId(aggregate: string): string {
  return `concept:${slugify(aggregate)}`;
}

function source(runId?: string): LayerNode["source"] {
  return { tool: TOOL, ...(runId ? { runId } : {}) };
}

export function emitConceptNodes(glossary: Glossary, runId?: string): LayerNode[] {
  return glossary.concepts.map((concept) => {
    const conceptId = canonicalId(concept);
    return {
      nodeId: `intent:concept/${conceptId}`,
      layer: "intent" as const,
      localName: concept.name,
      raw: {
        conceptId,
        canonicalName: concept.name,
        aliases: concept.aliases ?? [],
        kind: concept.kind ?? null,
        context: concept.context ?? null,
        attributes: concept.attributes,
        dependsOn: concept.dependsOn ?? [],
      },
      source: source(runId),
    };
  });
}

export function emitEventNodes(glossary: Glossary, runId?: string): LayerNode[] {
  return (glossary.events ?? []).map((event: GlossaryEvent) => ({
    nodeId: `intent:event/${slugify(event.name)}`,
    layer: "intent" as const,
    localName: event.name,
    raw: {
      eventName: event.name,
      aggregate: event.aggregate ?? null,
      aggregateConceptId: event.aggregate ? aggregateConceptId(event.aggregate) : null,
      context: event.context ?? null,
      trigger: event.trigger ?? null,
      properties: event.properties ?? [],
      consumer: event.consumer ?? null,
    },
    source: source(runId),
  }));
}

export function emitStateTransitionNodes(glossary: Glossary, runId?: string): LayerNode[] {
  return (glossary.stateTransitions ?? []).map((t: GlossaryStateTransition) => {
    const fromSlug = slugify(t.from) || "init"; // "∅" creation → "init"
    const toSlug = slugify(t.to) || "end";
    return {
      nodeId: `intent:transition/${slugify(t.aggregate)}/${fromSlug}--${toSlug}`,
      layer: "intent" as const,
      localName: `${t.aggregate}: ${t.from} → ${t.to}`,
      raw: {
        aggregate: t.aggregate,
        aggregateConceptId: aggregateConceptId(t.aggregate),
        context: t.context ?? null,
        from: t.from,
        to: t.to,
        trigger: t.trigger ?? null,
        event: t.event ?? null,
      },
      source: source(runId),
    };
  });
}

/**
 * All intent nodes from a glossary: concepts (id issuers) + events + state
 * transitions. The two latter are the mechanical intent↔structure diff axis.
 */
export function emitIntentNodes(glossary: Glossary, runId?: string): LayerNode[] {
  return [
    ...emitConceptNodes(glossary, runId),
    ...emitEventNodes(glossary, runId),
    ...emitStateTransitionNodes(glossary, runId),
  ];
}
