// packages/reconciler/src/pipeline.ts
//
// ingest → match → classify → adr → (queue/burn-in) → emit. Turns the three layer
// emits (plus ADRs and the prior registry) into the two files the reconciler owns:
// the durable registry (spine + human decisions) and the derived unified view.
//
// Concepts come from three places:
//   - intent glossary  → canonical concepts (the id issuer)
//   - structure entities with no intent match → synthesized concepts (classified
//     aggregate-internal / implementation-detail / adjudicated / code-only / unmatched)
//   - routes that anchor to no matched concept → route concepts (the structure↔behavior
//     leftovers: code-only / unmatched), exactly as M1.

import type {
  Adr,
  Concept,
  ConceptState,
  LayerNode,
  Registry,
  Relation,
  Unified,
  UnifiedConcept,
} from "@crawl-kit/contract";
import { emptyRegistry } from "@crawl-kit/contract";
import { findAdjudication, findViolations } from "./adr.js";
import { classifyUnmatchedEntity } from "./classify.js";
import { matchIntentToStructure, type MatchOptions } from "./match/intent-structure.js";
import { normalizeRoute } from "./match/route.js";
import {
  asIntentConcept,
  asStructureEntity,
  asStructureRoute,
  isConceptNode,
  isEntityNode,
  isRouteNode,
  type StructureEntity,
} from "./nodes.js";
import { entityNodeId, resolveDecisions, type HumanDecision } from "./queue.js";

export interface ReconcileInput {
  intent: LayerNode[];
  structure: LayerNode[];
  behavior: LayerNode[];
  adrs?: Adr[];
  prior?: Registry;
  decisions?: HumanDecision[];
}

export interface ReconcileOptions extends MatchOptions {
  now?: string;
}

export interface ReconcileResult {
  registry: Registry;
  unified: Unified;
  /** entities still awaiting a human same-as decision (ambiguous, not burned in). */
  queue: Array<{ entity: string; bestConceptId: string; composite: number }>;
}

/** A concept under construction, before it becomes a registry Concept + unified row. */
interface Building {
  conceptId: string;
  canonicalName: string;
  kind?: Concept["kind"];
  state: ConceptState;
  intent?: LayerNode;
  structure: LayerNode[];
  behavior: LayerNode[];
  decisions: string[];
  divergences: UnifiedConcept["divergences"];
}

export async function reconcile(
  input: ReconcileInput,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date().toISOString();
  const adrs = input.adrs ?? [];
  const prior = input.prior ?? emptyRegistry();

  const concepts = input.intent.filter(isConceptNode).map(asIntentConcept);
  const entities = input.structure.filter(isEntityNode).map(asStructureEntity);
  const routes = input.structure.filter(isRouteNode).map(asStructureRoute);

  const conceptById = new Map(concepts.map((c) => [c.conceptId, c]));
  const aggregateRootConceptIds = new Set(
    concepts.filter((c) => c.kind === "aggregate-root").map((c) => c.conceptId),
  );

  // ---- intent ↔ structure matching ---------------------------------------
  const match = await matchIntentToStructure(concepts, entities, options);
  const relations: Relation[] = [];
  const entityNameToConceptId = match.entityNameToConceptId;

  // burn-in: apply prior + fresh human decisions to the ambiguous queue
  const decisions = resolveDecisions(prior, input.decisions ?? []);
  const stillQueued: typeof match.queued = [];
  const humanMatched = new Map<string, string>(); // entity name → human-decided concept id
  for (const q of match.queued) {
    const decision = decisions.get(entityNodeId(q.entity.name));
    if (decision && conceptById.has(decision.conceptId)) {
      // record the resolution; attachEntity (below) emits the single same-as relation
      entityNameToConceptId.set(q.entity.name, decision.conceptId);
      humanMatched.set(q.entity.name, decision.conceptId);
    } else {
      stillQueued.push(q);
    }
  }
  const queuedEntityNames = new Set(stillQueued.map((q) => q.entity.name));

  // ---- seed canonical concepts from intent -------------------------------
  const building = new Map<string, Building>();
  for (const c of concepts) {
    building.set(c.conceptId, {
      conceptId: c.conceptId,
      canonicalName: c.canonicalName,
      kind: c.kind as Concept["kind"] | undefined,
      state: "intent-only",
      intent: c.node,
      structure: [],
      behavior: [],
      decisions: [],
      divergences: [],
    });
  }

  // attach matched structure entities to their concept
  const attachEntity = (conceptId: string, entity: StructureEntity, evidence: Relation["evidence"], decidedBy: "auto" | "human") => {
    const b = building.get(conceptId);
    if (!b) return;
    b.structure.push(entity.node);
    b.state = "aligned";
    relations.push({ kind: "same-as", from: entity.node.nodeId, to: conceptId, evidence, decidedBy, decidedAt: now });
  };
  for (const m of match.accepted) {
    attachEntity(m.conceptId, m.entity, m.evidence, "auto");
  }
  for (const q of match.queued) {
    const conceptId = humanMatched.get(q.entity.name);
    if (conceptId) attachEntity(conceptId, q.entity, q.evidence, "human");
  }

  // ---- behavior attachment via route → entity → concept ------------------
  const routeKeyToConcept = new Map<string, string>(); // normalized route → conceptId
  const structureRouteByKey = new Map<string, LayerNode>();
  for (const r of routes) {
    const key = normalizeRoute(r.routeKey);
    structureRouteByKey.set(key, r.node);
    const conceptId = r.entity ? entityNameToConceptId.get(r.entity) : undefined;
    if (conceptId) routeKeyToConcept.set(key, conceptId);
  }

  const consumedBehavior = new Set<string>();
  for (const node of input.behavior) {
    if (!node.route) continue;
    const key = normalizeRoute(node.route);
    const conceptId = routeKeyToConcept.get(key);
    if (conceptId) {
      building.get(conceptId)?.behavior.push(node);
      consumedBehavior.add(node.nodeId);
      const structNode = structureRouteByKey.get(key);
      if (structNode) {
        relations.push({ kind: "same-as", from: structNode.nodeId, to: node.nodeId, decidedBy: "auto", decidedAt: now });
      }
    }
  }

  // ---- synthesized concepts for unmatched structure entities -------------
  const matchedEntityNames = new Set([...entityNameToConceptId.keys()]);
  for (const entity of entities) {
    if (matchedEntityNames.has(entity.name)) continue;
    const cls = classifyUnmatchedEntity(entity, {
      entityNameToConceptId,
      aggregateRootConceptIds,
      queuedEntityNames,
    });
    const conceptId = `concept:struct/${entity.name}`;
    const b: Building = {
      conceptId,
      canonicalName: entity.name,
      state: cls.state,
      structure: [entity.node],
      behavior: [],
      decisions: [],
      divergences: divergenceForEntityState(cls.state),
    };
    building.set(conceptId, b);
    if (cls.partOf) relations.push({ kind: "part-of", from: entity.node.nodeId, to: cls.partOf, decidedBy: "auto", decidedAt: now });
    if (cls.serves) relations.push({ kind: "serves", from: entity.node.nodeId, to: cls.serves, decidedBy: "auto", decidedAt: now });
  }

  // ---- ADR overlay: adjudicated + violates-decision ----------------------
  applyAdrOverlay(building, conceptById, entities, entityNameToConceptId, adrs);

  // ---- finalize matched-concept divergences (intent-only) ----------------
  for (const b of building.values()) {
    if (b.state === "intent-only") {
      b.divergences.push({ edge: "intent↔structure", detail: "designed, not built yet" });
    }
  }

  // ---- route leftovers (structure↔behavior edge, M1-style) ---------------
  const routeConcepts = buildRouteConcepts(routes, input.behavior, routeKeyToConcept, consumedBehavior, now);
  for (const rc of routeConcepts) building.set(rc.conceptId, rc);

  // ---- assemble registry + unified ---------------------------------------
  return assemble(building, relations, adrs, now, stillQueued);
}

// ---------------------------------------------------------------------------

function divergenceForEntityState(state: ConceptState): UnifiedConcept["divergences"] {
  if (state === "code-only") {
    return [{ edge: "intent↔structure", detail: "exists in code with no matching intent — a possible leak" }];
  }
  if (state === "unmatched") {
    return [{ edge: "intent↔structure", detail: "ambiguous match — awaiting a human decision (manual queue)" }];
  }
  return []; // aggregate-internal / implementation-detail are legitimate — no red edge
}

function applyAdrOverlay(
  building: Map<string, Building>,
  conceptById: Map<string, { conceptId: string }>,
  entities: StructureEntity[],
  entityNameToConceptId: Map<string, string>,
  adrs: Adr[],
): void {
  // structure dependency graph resolved to concept ids (for forbid/require checks)
  const structureDeps = new Map<string, Set<string>>();
  for (const entity of entities) {
    const fromConcept = entityNameToConceptId.get(entity.name);
    if (!fromConcept) continue;
    const deps = structureDeps.get(fromConcept) ?? new Set<string>();
    for (const dep of entity.dependsOn) {
      const to = entityNameToConceptId.get(dep);
      if (to) deps.add(to);
    }
    structureDeps.set(fromConcept, deps);
  }

  const violations = findViolations(adrs, structureDeps);
  for (const [conceptId, v] of violations) {
    const b = building.get(conceptId);
    if (!b) continue;
    b.state = "violates-decision";
    if (!b.decisions.includes(v.adrId)) b.decisions.push(v.adrId);
    b.divergences.push({ edge: "intent↔structure", detail: v.detail, violates: v.adrId });
  }

  // adjudication for synthesized entity-concepts that hang off an ADR-noted concept
  for (const entity of entities) {
    if (entityNameToConceptId.has(entity.name)) continue;
    const b = building.get(`concept:struct/${entity.name}`);
    if (!b) continue;
    const depConcepts = new Set(
      entity.dependsOn.map((d) => entityNameToConceptId.get(d)).filter((x): x is string => Boolean(x)),
    );
    const adj = findAdjudication(adrs, depConcepts);
    if (adj) {
      b.state = "adjudicated";
      if (!b.decisions.includes(adj.adrId)) b.decisions.push(adj.adrId);
      b.divergences = [{ edge: "intent↔structure", detail: adj.detail, adjudicatedBy: adj.adrId }];
    }
  }
}

function buildRouteConcepts(
  routes: ReturnType<typeof asStructureRoute>[],
  behavior: LayerNode[],
  routeKeyToConcept: Map<string, string>,
  consumedBehavior: Set<string>,
  now: string,
): Building[] {
  const out: Building[] = [];
  const behaviorByKey = new Map<string, LayerNode[]>();
  for (const node of behavior) {
    if (!node.route) continue;
    const key = normalizeRoute(node.route);
    (behaviorByKey.get(key) ?? behaviorByKey.set(key, []).get(key)!).push(node);
  }

  // structure routes that anchor to no matched concept → standalone route concepts
  for (const r of routes) {
    const key = normalizeRoute(r.routeKey);
    if (routeKeyToConcept.has(key)) continue; // already folded into a domain concept
    const obs = behaviorByKey.get(key) ?? [];
    const state: ConceptState = obs.length > 0 ? "aligned" : "code-only";
    out.push({
      conceptId: `concept:route/${key}`,
      canonicalName: key,
      state,
      structure: [r.node],
      behavior: obs,
      decisions: [],
      divergences: state === "code-only"
        ? [{ edge: "structure↔behavior", detail: "built in structure but never observed at runtime" }]
        : [],
    });
    for (const o of obs) consumedBehavior.add(o.nodeId);
  }

  // behavior routes nobody claimed → unmatched route concepts
  const seen = new Set<string>();
  for (const node of behavior) {
    if (!node.route || consumedBehavior.has(node.nodeId)) continue;
    const key = normalizeRoute(node.route);
    if (seen.has(key)) continue;
    seen.add(key);
    const obs = (behaviorByKey.get(key) ?? []).filter((n) => !consumedBehavior.has(n.nodeId));
    out.push({
      conceptId: `concept:route/${key}`,
      canonicalName: key,
      state: "unmatched",
      structure: [],
      behavior: obs,
      decisions: [],
      divergences: [{ edge: "structure↔behavior", detail: "observed at runtime but absent from structure" }],
    });
  }
  return out;
}

function assemble(
  building: Map<string, Building>,
  relations: Relation[],
  adrs: Adr[],
  now: string,
  stillQueued: Array<{ entity: StructureEntity; bestConceptId: string; composite: number }>,
): ReconcileResult {
  const adrById = new Map(adrs.map((a) => [a.adrId, a]));
  const concepts: Record<string, Concept> = {};
  const unifiedConcepts: UnifiedConcept[] = [];

  const ordered = [...building.values()].sort((a, b) => a.conceptId.localeCompare(b.conceptId));
  for (const b of ordered) {
    const nodes: Concept["nodes"] = {};
    if (b.intent) nodes.intent = [b.intent.nodeId];
    if (b.structure.length) nodes.structure = b.structure.map((n) => n.nodeId);
    if (b.behavior.length) nodes.behavior = b.behavior.map((n) => n.nodeId);

    concepts[b.conceptId] = {
      conceptId: b.conceptId,
      canonicalName: b.canonicalName,
      aliases: [],
      ...(b.kind ? { kind: b.kind } : {}),
      nodes,
      state: b.state,
      decisions: b.decisions,
    };

    unifiedConcepts.push({
      conceptId: b.conceptId,
      canonicalName: b.canonicalName,
      state: b.state,
      ...(b.intent ? { intent: b.intent } : {}),
      ...(b.structure.length ? { structure: b.structure } : {}),
      ...(b.behavior.length ? { behavior: b.behavior } : {}),
      decisions: b.decisions.map((id) => adrById.get(id)).filter((a): a is Adr => Boolean(a)),
      divergences: b.divergences,
    });
  }

  const adrsRecord: Record<string, Adr> = {};
  for (const a of adrs) adrsRecord[a.adrId] = a;

  const registry: Registry = { version: 1, concepts, adrs: adrsRecord, relations };
  const unified: Unified = { version: 1, generatedAt: now, concepts: unifiedConcepts };
  // only report items whose final state is still genuinely unmatched — an ADR may
  // have adjudicated what the matcher left ambiguous, which resolves it without a human.
  const queue = stillQueued
    .filter((q) => building.get(`concept:struct/${q.entity.name}`)?.state === "unmatched")
    .map((q) => ({ entity: q.entity.name, bestConceptId: q.bestConceptId, composite: q.composite }));
  return { registry, unified, queue };
}
