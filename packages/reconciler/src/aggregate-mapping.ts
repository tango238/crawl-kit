// packages/reconciler/src/aggregate-mapping.ts
//
// Derive a DDD aggregate → structure-entity mapping from the unified concept
// graph plus the intent-side aggregate roster. Pure and silent — no I/O.
//
// AggregateDoc (from packages/intent/src/aggregates.ts) is consumed
// STRUCTURALLY here: reconciler already depends on @crawl-kit/contract, and we
// avoid adding an intent dependency just for one shape, so `AggregateDocLike`
// is declared locally and only needs to match by structure.

import type { LayerNode, Unified } from "@crawl-kit/contract";

const STRUCTURE_ENTITY_PREFIX = "structure:entity/";

export interface AggregateDocMemberLike {
  conceptId: string;
  name: string;
  via?: string;
}

export interface AggregateDocEntryLike {
  conceptId: string;
  name: string;
  members: AggregateDocMemberLike[];
}

/** Structural mirror of packages/intent/src/aggregates.ts's AggregateDoc. */
export interface AggregateDocLike {
  aggregates: AggregateDocEntryLike[];
}

export interface AggregateEntityMapping {
  generatedAt: string;
  aggregates: Array<{
    conceptId: string;
    name: string;
    entities: Array<{
      nodeId: string;
      entity: string;
      repo?: string;
      confidence: number;
      evidence: string;
    }>;
  }>;
  unassigned: Array<{ nodeId: string; entity: string; repo?: string }>;
}

/** lowercase, alphanumeric-only slug — used only for the name-similarity rescue. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** human-readable entity name: prefer the LayerNode's localName, else the nodeId tail. */
function entityName(node: LayerNode): string {
  if (node.localName) return node.localName;
  const idx = node.nodeId.lastIndexOf("/");
  return idx >= 0 ? node.nodeId.slice(idx + 1) : node.nodeId;
}

/** repo tag transferred straight through from the LayerNode when present (P2). */
function nodeRepo(node: LayerNode): string | undefined {
  return (node as { repo?: string }).repo;
}

interface NameMatch {
  aggregate: AggregateDocEntryLike;
  confidence: number;
  evidence: string;
}

/**
 * Best name-similarity rescue for an entity slug against every aggregate's own
 * name + member names: exact slug equality (0.6, "name match") beats
 * either-direction substring containment (0.4, "partial name match"). Ties are
 * broken by aggregate document order (first candidate found wins).
 */
function bestNameMatch(entitySlug: string, aggregates: AggregateDocEntryLike[]): NameMatch | undefined {
  if (!entitySlug) return undefined;

  let best: NameMatch | undefined;
  for (const aggregate of aggregates) {
    const candidateSlugs = [aggregate.name, ...aggregate.members.map((m) => m.name)]
      .map(slugify)
      .filter((slug) => slug.length > 0);

    for (const candidate of candidateSlugs) {
      let confidence: number | undefined;
      let evidence: string | undefined;
      if (candidate === entitySlug) {
        confidence = 0.6;
        evidence = "name match";
      } else if (candidate.includes(entitySlug) || entitySlug.includes(candidate)) {
        confidence = 0.4;
        evidence = "partial name match";
      }
      if (confidence !== undefined && (!best || confidence > best.confidence)) {
        best = { aggregate, confidence, evidence: evidence as string };
      }
    }
  }

  return best;
}

/**
 * Pure derivation of an aggregate → structure-entity mapping.
 *
 *   1. concept IS an aggregate root       → confidence 0.95, "reconciled to aggregate root"
 *   2. concept IS a member (any via)      → confidence 0.85, "reconciled to member <name>"
 *   3. otherwise, name-similarity rescue  → 0.6 "name match" | 0.4 "partial name match"
 *   4. no match at all                    → unassigned
 */
export function deriveAggregateEntityMapping(
  unified: Unified,
  aggregates: AggregateDocLike,
  opts?: { now?: string },
): AggregateEntityMapping {
  const generatedAt = opts?.now ?? new Date().toISOString();
  const docAggregates = aggregates.aggregates;

  const rootByConceptId = new Map<string, AggregateDocEntryLike>();
  const memberByConceptId = new Map<string, { aggregate: AggregateDocEntryLike; memberName: string }>();
  for (const aggregate of docAggregates) {
    rootByConceptId.set(aggregate.conceptId, aggregate);
    for (const member of aggregate.members) {
      if (!memberByConceptId.has(member.conceptId)) {
        memberByConceptId.set(member.conceptId, { aggregate, memberName: member.name });
      }
    }
  }

  type MappedEntity = AggregateEntityMapping["aggregates"][number]["entities"][number];
  const entitiesByAggregate = new Map<AggregateDocEntryLike, MappedEntity[]>(
    docAggregates.map((aggregate) => [aggregate, []]),
  );
  const unassigned: AggregateEntityMapping["unassigned"] = [];

  for (const concept of unified.concepts) {
    for (const node of concept.structure ?? []) {
      if (!node.nodeId.startsWith(STRUCTURE_ENTITY_PREFIX)) continue;

      const entity = entityName(node);
      const repo = nodeRepo(node);
      const base = { nodeId: node.nodeId, entity, ...(repo ? { repo } : {}) };

      const root = rootByConceptId.get(concept.conceptId);
      if (root) {
        entitiesByAggregate.get(root)?.push({
          ...base,
          confidence: 0.95,
          evidence: "reconciled to aggregate root",
        });
        continue;
      }

      const member = memberByConceptId.get(concept.conceptId);
      if (member) {
        entitiesByAggregate.get(member.aggregate)?.push({
          ...base,
          confidence: 0.85,
          evidence: `reconciled to member ${member.memberName}`,
        });
        continue;
      }

      const nameMatch = bestNameMatch(slugify(entity), docAggregates);
      if (nameMatch) {
        entitiesByAggregate.get(nameMatch.aggregate)?.push({
          ...base,
          confidence: nameMatch.confidence,
          evidence: nameMatch.evidence,
        });
        continue;
      }

      unassigned.push(base);
    }
  }

  return {
    generatedAt,
    aggregates: docAggregates.map((aggregate) => ({
      conceptId: aggregate.conceptId,
      name: aggregate.name,
      entities: entitiesByAggregate.get(aggregate) ?? [],
    })),
    unassigned,
  };
}
