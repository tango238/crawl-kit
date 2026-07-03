// packages/structure/src/gap/crud.ts
//
// ← gap/crud_analyzer.py (gap extraction). Finds the CRUD gaps per entity using the
// full multi-source CRUD index (entity_operations ∪ routes-by-path ∪ usecases), plus
// usecases pointing at entities that aren't in the model.

import { buildCrudIndex } from "../crud.js";
import type { Crud, StructureExtract } from "../model.js";

export interface CrudGap {
  entity: string;
  /** CRUD letters the entity is NEVER touched with. */
  missing: Crud[];
}

export interface CrudReport {
  gaps: CrudGap[];
  /** usecases whose entity is absent from the information model. */
  danglingUsecases: string[];
}

const ALL_CRUD: Crud[] = ["C", "R", "U", "D"];

export function analyzeCrud(extract: StructureExtract): CrudReport {
  const index = buildCrudIndex(extract);
  const gaps: CrudGap[] = [];
  for (const e of extract.entities) {
    const present = new Set(index.get(e.name) ?? []);
    const missing = ALL_CRUD.filter((c) => !present.has(c));
    if (missing.length > 0) gaps.push({ entity: e.name, missing });
  }

  const entityNames = new Set(extract.entities.map((e) => e.name));
  const dangling = new Set<string>();
  for (const uc of extract.usecases) {
    if (!entityNames.has(uc.entity)) dangling.add(uc.name);
  }

  return { gaps, danglingUsecases: [...dangling] };
}
