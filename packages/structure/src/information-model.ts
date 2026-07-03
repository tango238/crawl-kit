// packages/structure/src/information-model.ts
//
// ← rdra/information_model.py. Builds the normalized information model from a raw
// extract: the entity graph (nodes + dependency edges) and the route→entity map the
// emit step needs to anchor the structure↔behavior edge to the domain.

import type { Crud, EntityRecord, StructureExtract, UsecaseRecord } from "./model.js";

export interface EntityNode {
  name: string;
  attributes: string[];
  dependsOn: string[];
  /** reverse edges — entities that depend on this one. */
  dependedOnBy: string[];
}

export interface InformationModel {
  entities: Map<string, EntityNode>;
  /** raw route key ("GET /orders/:id") → { entity, crud } from the usecases. */
  routeToEntity: Map<string, { entity: string; crud: Crud[] }>;
  usecasesByEntity: Map<string, UsecaseRecord[]>;
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function buildInformationModel(extract: StructureExtract): InformationModel {
  const entities = new Map<string, EntityNode>();
  for (const e of extract.entities) {
    entities.set(e.name, {
      name: e.name,
      attributes: [...e.attributes],
      dependsOn: [...(e.dependsOn ?? [])],
      dependedOnBy: [],
    });
  }
  // wire reverse edges (skip dangling targets — they just won't get a back-edge)
  for (const e of entities.values()) {
    for (const target of e.dependsOn) {
      entities.get(target)?.dependedOnBy.push(e.name);
    }
  }

  const routeToEntity = new Map<string, { entity: string; crud: Crud[] }>();
  const usecasesByEntity = new Map<string, UsecaseRecord[]>();
  for (const uc of extract.usecases) {
    const bucket = usecasesByEntity.get(uc.entity);
    if (bucket) bucket.push(uc);
    else usecasesByEntity.set(uc.entity, [uc]);
    if (uc.route) {
      routeToEntity.set(routeKey(uc.route.method, uc.route.path), {
        entity: uc.entity,
        crud: uc.crud,
      });
    }
  }

  return { entities, routeToEntity, usecasesByEntity };
}
