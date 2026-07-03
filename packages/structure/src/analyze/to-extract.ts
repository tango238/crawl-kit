// packages/structure/src/analyze/to-extract.ts
//
// The contract bridge. rdra-analyzer's analysis produces routes / models / usecases /
// relationships; crawl-kit's contract is a StructureExtract (routes + entities +
// usecases). Per the goal, the OUTPUT contract wins: this adapter projects the rich
// parse result onto StructureExtract so the rest of the suite (emit → LayerNode →
// reconciler) is unchanged. Nothing downstream needs to know the parser exists.

import type {
  Crud,
  EntityOperation,
  EntityRecord,
  RouteRecord,
  StructureEvent,
  StructureExtract,
  StructureStateTransition,
  UsecaseRecord,
} from "../model.js";
import type { Entity, Relationship } from "./derived/information-model.js";
import type { EntityOperation as ParsedEntityOperation, ParsedModel, ParsedPage, ParsedRoute } from "./source-parser.js";
import type { UseCase } from "./usecase-extractor.js";

/** Canonical entity identity used across EntityRecord.name and UsecaseRecord.entity. */
function canonical(entity: { tableName: string; className: string }): string {
  return entity.tableName || entity.className.toLowerCase();
}

function crudForMethod(method: string): Crud {
  switch (method.toUpperCase()) {
    case "POST": return "C";
    case "PUT":
    case "PATCH": return "U";
    case "DELETE": return "D";
    default: return "R";
  }
}

function splitRoute(routeStr: string): { method: string; path: string } {
  const parts = routeStr.trim().split(/\s+/);
  if (parts.length >= 2) return { method: parts[0]!, path: parts.slice(1).join(" ") };
  return { method: "GET", path: parts[0]! };
}

export interface AnalysisResult {
  routes: ParsedRoute[];
  models: ParsedModel[];
  entities: Entity[];
  relationships: Relationship[];
  usecases: UseCase[];
  entityOperations?: ParsedEntityOperation[];
  /** parsed pages — source of per-route input fields (the Input facet). */
  pages?: ParsedPage[];
  /** events found in code (from the deterministic diff-axis scan). */
  events?: StructureEvent[];
  /** state transitions found in code (from the deterministic diff-axis scan). */
  stateTransitions?: StructureStateTransition[];
  /** route → emitted event names, keyed by "METHOD path" (from the route→event trace). */
  routeEvents?: Record<string, string[]>;
}

export function toStructureExtract(analysis: AnalysisResult): StructureExtract {
  // name resolution: entity display name / class name → canonical key
  const toCanonical = new Map<string, string>();
  for (const e of analysis.entities) {
    const key = canonical(e);
    toCanonical.set(e.name, key);
    toCanonical.set(e.className, key);
    if (e.tableName) toCanonical.set(e.tableName, key);
  }
  const resolve = (name: string): string => toCanonical.get(name) ?? name.toLowerCase();

  // dependsOn: from the relationship edges, expressed in canonical entity names
  const dependsOn = new Map<string, Set<string>>();
  for (const rel of analysis.relationships) {
    const from = resolve(rel.fromEntity);
    const to = resolve(rel.toEntity);
    if (from === to) continue;
    (dependsOn.get(from) ?? dependsOn.set(from, new Set()).get(from)!).add(to);
  }

  const entities: EntityRecord[] = analysis.entities.map((e) => {
    const name = canonical(e);
    return {
      name,
      attributes: e.attributes,
      ...(dependsOn.has(name) ? { dependsOn: [...dependsOn.get(name)!] } : {}),
      ...(e.description ? { source: e.description } : {}),
    };
  });

  // route → declared input fields, from the parsed pages (matched by path).
  const inputsByPath = new Map<string, Set<string>>();
  for (const page of analysis.pages ?? []) {
    if (!page.routePath || !page.formFields?.length) continue;
    const set = inputsByPath.get(page.routePath) ?? new Set<string>();
    for (const f of page.formFields) set.add(f);
    inputsByPath.set(page.routePath, set);
  }

  const routeEvents = analysis.routeEvents ?? {};
  const routes: RouteRecord[] = analysis.routes.map((r) => {
    const inputs = inputsByPath.get(r.path);
    const events = routeEvents[`${r.method.toUpperCase()} ${r.path}`];
    return {
      method: r.method,
      path: r.path,
      ...(r.action || r.controller ? { handler: r.action || r.controller } : {}),
      ...(inputs && inputs.size ? { inputs: [...inputs] } : {}),
      ...(events && events.length ? { events } : {}),
    };
  });

  // one UsecaseRecord per (UC × related route). A usecase may touch several
  // entities (1-to-many): keep them all, with entities[0] as the primary anchor.
  const usecases: UsecaseRecord[] = [];
  for (const uc of analysis.usecases) {
    const entities = [...new Set(uc.relatedEntities.map(resolve).filter(Boolean))];
    const primaryEntity = entities[0];
    if (!primaryEntity) continue;
    for (const routeStr of uc.relatedRoutes) {
      const { method, path } = splitRoute(routeStr);
      usecases.push({
        name: uc.name,
        entity: primaryEntity,
        entities,
        route: { method, path },
        crud: [crudForMethod(method)],
      });
    }
  }

  // code-level CRUD operations — the strongest CRUD signal, kept first-class so
  // buildCrudIndex can see operations the HTTP method can't (indirect Service calls).
  const entityOperations: EntityOperation[] = (analysis.entityOperations ?? []).map((op) => ({
    entityClass: op.entityClass,
    operation: op.operation as EntityOperation["operation"],
    ...(op.methodSignature ? { methodSignature: op.methodSignature } : {}),
    ...(op.callChain && op.callChain.length ? { callChain: op.callChain } : {}),
  }));

  return {
    entities,
    routes,
    usecases,
    ...(entityOperations.length ? { entityOperations } : {}),
    ...(analysis.events?.length ? { events: analysis.events } : {}),
    ...(analysis.stateTransitions?.length ? { stateTransitions: analysis.stateTransitions } : {}),
  };
}
