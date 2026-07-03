// packages/viewer/src/intent-model.ts
//
// The intent menu: events, aggregates, and state transitions as the glossary
// (distill-ddd) declared them. Reads intent.nodes.json (events + transitions,
// LayerNode-shaped) and joins it against intent.aggregates.json (the aggregate
// roster) and mapping.aggregate-entity.json (aggregate → structure entity
// evidence, from the reconciler) so a menu row can show "this aggregate is
// realized by these tables". viewer depends on @crawl-kit/contract only, so
// every shape below is a LOCAL structural mirror of intent's/reconciler's own
// types — read structurally, not imported.
//
// joinIntentModel is pure (no I/O); buildIntentModel is the tolerant I/O
// wrapper — any missing/corrupt file degrades to an empty array, never throws.

import { DATA_FILES, dataPath, readJsonFileOr, resolveRoot } from "@crawl-kit/contract";

export interface IntentEvent {
  name: string;
  aggregate?: string | null;
  trigger?: string | null;
  properties?: string[];
  consumer?: string | null;
}

export interface IntentTransition {
  aggregate: string;
  from: string;
  to: string;
  trigger?: string | null;
  event?: string | null;
}

export interface IntentAggregateMember {
  conceptId: string;
  name: string;
  via: string;
}

export interface IntentAggregateEntity {
  entity: string;
  repo?: string;
  confidence: number;
  evidence: string;
}

export interface IntentAggregate {
  name: string;
  conceptId: string;
  members: IntentAggregateMember[];
  /** structure entities realizing this aggregate, from mapping.aggregate-entity.json — with confidence/evidence/repo. */
  entities: IntentAggregateEntity[];
}

export interface IntentUnassignedEntity {
  entity: string;
  repo?: string;
}

export interface IntentModel {
  events: IntentEvent[];
  aggregates: IntentAggregate[];
  transitions: IntentTransition[];
  /** structure entities the reconciler couldn't match to any aggregate. Empty when mapping.aggregate-entity.json is absent. */
  unassigned: IntentUnassignedEntity[];
}

/** Structural mirror of contract's LayerNode — only the fields this module reads. */
interface LayerNodeLike {
  nodeId: string;
  raw?: Record<string, unknown> | null;
}

/** Structural mirror of packages/intent/src/aggregates.ts's AggregateDoc. */
interface AggregateDocLike {
  aggregates?: Array<{ conceptId: string; name: string; members?: IntentAggregateMember[] }>;
}

/** Structural mirror of packages/reconciler/src/aggregate-mapping.ts's AggregateEntityMapping. */
interface MappingLike {
  aggregates?: Array<{
    conceptId: string;
    entities?: Array<{ entity: string; repo?: string; confidence: number; evidence: string }>;
  }>;
  unassigned?: Array<{ entity: string; repo?: string }>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readEvents(nodes: LayerNodeLike[]): IntentEvent[] {
  return nodes
    .filter((n) => n.nodeId.startsWith("intent:event/"))
    .map((n) => ({
      name: asString(n.raw?.eventName),
      aggregate: asNullableString(n.raw?.aggregate),
      trigger: asNullableString(n.raw?.trigger),
      properties: Array.isArray(n.raw?.properties) ? (n.raw?.properties as string[]) : [],
      consumer: asNullableString(n.raw?.consumer),
    }));
}

function readTransitions(nodes: LayerNodeLike[]): IntentTransition[] {
  return nodes
    .filter((n) => n.nodeId.startsWith("intent:transition/"))
    .map((n) => ({
      aggregate: asString(n.raw?.aggregate),
      from: asString(n.raw?.from),
      to: asString(n.raw?.to),
      trigger: asNullableString(n.raw?.trigger),
      event: asNullableString(n.raw?.event),
    }));
}

function readAggregates(aggregateDoc: AggregateDocLike, mapping: MappingLike): IntentAggregate[] {
  const entitiesByConcept = new Map<string, IntentAggregateEntity[]>();
  for (const agg of mapping.aggregates ?? []) {
    entitiesByConcept.set(
      agg.conceptId,
      (agg.entities ?? []).map((e) => ({
        entity: e.entity,
        ...(e.repo ? { repo: e.repo } : {}),
        confidence: e.confidence,
        evidence: e.evidence,
      })),
    );
  }

  return (aggregateDoc.aggregates ?? []).map((agg) => ({
    name: agg.name,
    conceptId: agg.conceptId,
    members: agg.members ?? [],
    entities: entitiesByConcept.get(agg.conceptId) ?? [],
  }));
}

function readUnassigned(mapping: MappingLike): IntentUnassignedEntity[] {
  return (mapping.unassigned ?? []).map((u) => ({
    entity: u.entity,
    ...(u.repo ? { repo: u.repo } : {}),
  }));
}

/** Pure join: intent.nodes.json + intent.aggregates.json + mapping.aggregate-entity.json → IntentModel. */
export function joinIntentModel(
  nodes: LayerNodeLike[],
  aggregateDoc: AggregateDocLike,
  mapping: MappingLike,
): IntentModel {
  return {
    events: readEvents(nodes),
    aggregates: readAggregates(aggregateDoc, mapping),
    transitions: readTransitions(nodes),
    unassigned: readUnassigned(mapping),
  };
}

export async function buildIntentModel(): Promise<IntentModel> {
  const root = resolveRoot();
  const nodes = await readJsonFileOr<LayerNodeLike[]>(dataPath(DATA_FILES.intentNodes, root), []);
  const aggregateDoc = await readJsonFileOr<AggregateDocLike>(dataPath(DATA_FILES.intentAggregates, root), {
    aggregates: [],
  });
  const mapping = await readJsonFileOr<MappingLike>(dataPath(DATA_FILES.aggregateEntityMapping, root), {
    aggregates: [],
    unassigned: [],
  });
  return joinIntentModel(nodes, aggregateDoc, mapping);
}
