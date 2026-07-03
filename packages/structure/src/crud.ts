// packages/structure/src/crud.ts
//
// ← extraction/derived/crud_analyzer.py (the CRUD determination core). rdra decides an
// entity's CRUD from FOUR sources, strongest first:
//   1. entity_operations  — code-truth (a Service that decrements Stock = Update on Stock)
//   2. routes             — HTTP method, matched by the ENTITY NAME APPEARING IN THE PATH
//                           (DELETE /hotels/{id} → Delete on Hotel), independent of usecases
//   3. usecases           — HTTP method of the usecase's routes
// The route-by-path pass is the workhorse the first TS port was missing: it covers every
// route regardless of usecase extraction or any route cap. We match on whole, normalized
// path SEGMENTS (not rdra's substring) so "hotel" no longer leaks into "hotel_images".

import type { Crud, EntityOperation, StructureExtract } from "./model.js";

const HTTP_TO_CRUD: Record<string, Crud> = { POST: "C", GET: "R", PUT: "U", PATCH: "U", DELETE: "D" };
const OP_TO_CRUD: Record<string, Crud> = { Create: "C", Read: "R", Update: "U", Delete: "D" };
const CRUD_ORDER: Crud[] = ["C", "R", "U", "D"];

function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}
function singularize(t: string): string {
  if (t.endsWith("ies") && t.length > 3) return `${t.slice(0, -3)}y`;
  if (t.endsWith("ses") && t.length > 3) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 1) return t.slice(0, -1);
  return t;
}
/** Canonical comparison key — "Hotel"/"hotels"/"hotel_images" → "hotel"/"hotel"/"hotel image". */
export function normalizeEntityKey(name: string): string {
  return tokens(name).map(singularize).join(" ");
}

/** Does a route path contain a whole segment that denotes this entity? */
function routeTouchesEntity(path: string, entityKey: string): boolean {
  const segs = (path.split(/[?#]/)[0] ?? "")
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith(":") && !(s.startsWith("{") && s.endsWith("}")));
  return segs.some((seg) => normalizeEntityKey(seg) === entityKey);
}

/** CRUD for one entity from all available signals (entity_operations ∪ routes ∪ usecases).
 * A human override from the corrections overlay, when present, is authoritative. */
export function entityCrud(entityName: string, extract: StructureExtract): Crud[] {
  const override = extract.crudOverrides?.[entityName];
  if (override) return CRUD_ORDER.filter((c) => override.includes(c));

  const key = normalizeEntityKey(entityName);
  const set = new Set<Crud>();

  // 1. code-level operations (strongest) — match by normalized entity class name
  for (const op of extract.entityOperations ?? []) {
    if (op.entityClass && normalizeEntityKey(op.entityClass) === key) {
      const c = OP_TO_CRUD[op.operation];
      if (c) set.add(c);
    }
  }
  // 2. routes whose path names the entity (covers EVERY route, no usecase needed)
  for (const r of extract.routes) {
    if (routeTouchesEntity(r.path, key)) {
      const c = HTTP_TO_CRUD[r.method.toUpperCase()];
      if (c) set.add(c);
    }
  }
  // 3. usecases that touch the entity (1-to-many: any of uc.entities)
  for (const uc of extract.usecases) {
    const touches = (uc.entities ?? [uc.entity]).some((e) => normalizeEntityKey(e) === key);
    if (touches) for (const c of uc.crud) set.add(c);
  }

  return CRUD_ORDER.filter((c) => set.has(c));
}

/** entity name → CRUD, computed once for the whole extract. */
export function buildCrudIndex(extract: StructureExtract): Map<string, Crud[]> {
  const index = new Map<string, Crud[]>();
  for (const e of extract.entities) index.set(e.name, entityCrud(e.name, extract));
  return index;
}

export { OP_TO_CRUD, type EntityOperation };
