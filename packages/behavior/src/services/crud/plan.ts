import type { LayerNode } from '@crawl-kit/contract'
import type { ColumnDef } from '../explore/types.js'
import type { CrudPlan } from './types.js'

/** Columns never sent in a create body (server-managed). */
const SKIP_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'createdat', 'updatedat'])

function hasIdParam(path: string): boolean {
  return /\/:|\{[^}]+\}|:id/.test(path)
}

function raw(n: LayerNode): Record<string, unknown> {
  return (n.raw ?? {}) as Record<string, unknown>
}

/** A representative value for a column, by SQL data type. */
function placeholderValue(col: ColumnDef): unknown {
  const t = col.dataType.toLowerCase()
  if (/int|serial|numeric|decimal|real|double|float/.test(t)) return 1
  if (/bool/.test(t)) return true
  return `crud-${col.name}`
}

/** Pick the id column: prefer `id`, else the first NOT NULL column, else null. */
function pickIdColumn(columns: ColumnDef[]): string | null {
  if (columns.some((c) => c.name.toLowerCase() === 'id')) {
    return columns.find((c) => c.name.toLowerCase() === 'id')!.name
  }
  const notNull = columns.find((c) => !c.nullable)
  return notNull ? notNull.name : null
}

/** A column safe to mutate in an update: not id / not a skip (server-managed) column. */
function pickUpdatableColumn(columns: ColumnDef[], idColumn: string): string | null {
  const cand = columns.find((c) => c.name !== idColumn && !SKIP_COLUMNS.has(c.name.toLowerCase()))
  return cand ? cand.name : null
}

/** Insertable columns → representative values (excludes id / server-managed columns). */
function deriveBody(columns: ColumnDef[]): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const c of columns) {
    if (SKIP_COLUMNS.has(c.name.toLowerCase())) continue
    body[c.name] = placeholderValue(c)
  }
  return body
}

/** The minimal route shape the planner needs: HTTP method, path, and its entity. */
export type RouteInput = { method: string; path: string; entity: string }

/** A route from the Pass-1 partial (structure.routes.partial.json) — no entity yet. */
export type PartialRoute = { method: string; path: string }

const API_PREFIXES = new Set(['api'])

/** Does a path segment look like an id/param rather than a resource name? */
function isIdSegment(seg: string): boolean {
  return seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}')) || /^\d+$/.test(seg) || /^v\d+$/.test(seg)
}

/**
 * Infer the entity (table) name from a route path: the last resource segment, skipping id
 * params, API prefixes and version tags. "/api/v1/users/:id" → "users", "/orders" → "orders".
 */
export function entityFromPath(path: string): string {
  const segs = path.split('/').map((s) => s.trim()).filter((s) => s.length > 0)
  const resources = segs.filter((s) => !isIdSegment(s) && !API_PREFIXES.has(s.toLowerCase()))
  return (resources[resources.length - 1] ?? '').toLowerCase()
}

/** Entities referenced by a Pass-1 partial route list (for DB introspection). */
export function entitiesFromPartial(routes: PartialRoute[]): string[] {
  return [...new Set(routes.map((r) => entityFromPath(r.path)).filter(Boolean))]
}

/** Route inputs from full structure nodes — entity comes from the node's `raw.entity`. */
function routeInputsFromNodes(structureNodes: LayerNode[]): RouteInput[] {
  const out: RouteInput[] = []
  for (const n of structureNodes) {
    if (!n.nodeId.startsWith('structure:route/')) continue
    const r = raw(n)
    const entity = r.entity
    if (typeof entity !== 'string' || !entity) continue
    out.push({ method: String(r.method ?? '').toUpperCase(), path: String(r.path ?? ''), entity })
  }
  return out
}

/** Route inputs from a Pass-1 partial — entity inferred from the path. */
function routeInputsFromPartial(routes: PartialRoute[]): RouteInput[] {
  return routes
    .map((r) => ({ method: String(r.method ?? '').toUpperCase(), path: String(r.path ?? ''), entity: entityFromPath(r.path) }))
    .filter((r) => r.entity !== '')
}

/**
 * Derive one CRUD plan per entity from structure route nodes + DB columns.
 * - create = a POST route for the entity (no id param preferred)
 * - update = a PATCH/PUT route with an id param
 * - delete = a DELETE route with an id param
 * Entities without a create route, or without a resolvable id column, are skipped.
 * `bodyByTable[table]`, when given, overrides the DB-derived create body (observed/form shape wins).
 */
export function buildCrudPlans(
  structureNodes: LayerNode[],
  columnsByTable: Record<string, ColumnDef[]>,
  bodyByTable?: Record<string, Record<string, unknown>>,
): CrudPlan[] {
  return buildCrudPlansFromRoutes(routeInputsFromNodes(structureNodes), columnsByTable, bodyByTable)
}

/**
 * Build CRUD plans from a Pass-1 routes partial (structure.routes.partial.json). Entities are
 * inferred from paths, so plans are available before the detail passes finish; a later run on
 * full structure nodes (buildCrudPlans) refines them with the authoritative entity mapping.
 */
export function buildCrudPlansFromPartial(
  routes: PartialRoute[],
  columnsByTable: Record<string, ColumnDef[]>,
  bodyByTable?: Record<string, Record<string, unknown>>,
): CrudPlan[] {
  return buildCrudPlansFromRoutes(routeInputsFromPartial(routes), columnsByTable, bodyByTable)
}

/** Core planner over normalized route inputs (shared by the node + partial adapters). */
export function buildCrudPlansFromRoutes(
  routeInputs: RouteInput[],
  columnsByTable: Record<string, ColumnDef[]>,
  bodyByTable?: Record<string, Record<string, unknown>>,
): CrudPlan[] {
  const byEntity = new Map<string, RouteInput[]>()
  for (const r of routeInputs) {
    byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r])
  }

  const plans: CrudPlan[] = []
  for (const [entity, routeList] of byEntity) {
    const routes = routeList.map((r) => ({ method: r.method, path: r.path }))
    const posts = routes.filter((r) => r.method === 'POST')
    if (posts.length === 0) continue
    const create = posts.find((r) => !hasIdParam(r.path)) ?? posts[0]!

    const columns = columnsByTable[entity] ?? []
    const idColumn = pickIdColumn(columns)
    if (!idColumn) continue

    const updRoute = routes.find((r) => (r.method === 'PATCH' || r.method === 'PUT') && hasIdParam(r.path))
    const updatableColumn = pickUpdatableColumn(columns, idColumn)
    const update = updRoute && updatableColumn ? { ...updRoute, updatableColumn } : undefined

    const delRoute = routes.find((r) => r.method === 'DELETE' && hasIdParam(r.path))

    const body = bodyByTable?.[entity] ?? deriveBody(columns)

    plans.push({
      entity,
      table: entity,
      idColumn,
      create: { method: create.method, path: create.path },
      ...(update ? { update } : {}),
      ...(delRoute ? { delete: { method: delRoute.method, path: delRoute.path } } : {}),
      body,
    })
  }
  return plans
}
