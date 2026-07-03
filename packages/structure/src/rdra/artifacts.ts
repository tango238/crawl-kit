// packages/structure/src/rdra/artifacts.ts
//
// The human-readable RDRA model, assembled from the static extract. This is what
// rdra-analyzer's `viewer.html` used to show, reduced to its structure-only core
// (ADR-0003): the information model (entities + attributes + topology), the
// usecase→entity CRUD map, and the CRUD gaps. Plus Mermaid renderings.

import { buildCrudIndex } from "../crud.js";
import { analyzeCrud, type CrudReport } from "../gap/crud.js";
import { buildInformationModel } from "../information-model.js";
import type { Crud, StructureExtract } from "../model.js";
import { entityRelationshipDiagram, usecaseDiagram } from "./diagrams.js";

export interface RdraEntity {
  name: string;
  attributes: string[];
  dependsOn: string[];
  dependedOnBy: string[];
  crud: Crud[];
}

export interface RdraUsecase {
  name: string;
  entity: string;
  /** all entities this usecase touches (1-to-many); entities[0] === entity. */
  entities: string[];
  route?: string;
  crud: Crud[];
}

/** The serializable RDRA model — the thing you actually want to look at. */
export interface RdraModel {
  entities: RdraEntity[];
  usecases: RdraUsecase[];
  crud: CrudReport;
}

export interface RdraArtifacts {
  model: RdraModel;
  diagrams: { entityRelationship: string; usecases: string };
}

export function buildRdraArtifacts(extract: StructureExtract): RdraArtifacts {
  const im = buildInformationModel(extract);
  const crudIndex = buildCrudIndex(extract);

  const entities: RdraEntity[] = [...im.entities.values()].map((e) => ({
    name: e.name,
    attributes: e.attributes,
    dependsOn: e.dependsOn,
    dependedOnBy: e.dependedOnBy,
    crud: crudIndex.get(e.name) ?? [],
  }));

  const usecases: RdraUsecase[] = extract.usecases.map((uc) => ({
    name: uc.name,
    entity: uc.entity,
    entities: uc.entities ?? [uc.entity],
    ...(uc.route ? { route: `${uc.route.method.toUpperCase()} ${uc.route.path}` } : {}),
    crud: uc.crud,
  }));

  return {
    model: { entities, usecases, crud: analyzeCrud(extract) },
    diagrams: {
      entityRelationship: entityRelationshipDiagram(im),
      usecases: usecaseDiagram(im),
    },
  };
}
