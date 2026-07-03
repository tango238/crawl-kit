import { logger } from '../../util/logger.js'
import { normalizeRoute } from '@crawl-kit/reconciler'
import type { VerifyFinding } from '../../domain/types.js'
import type { DbAdapter } from '../db/adapter.js'
import { crudFinding } from './oracle.js'
import type { ApiClient, CrudEntityResult, CrudPlan, CrudStepResult } from './types.js'

export type ExecuteCrudDeps = {
  api: ApiClient
  db?: DbAdapter
  dbType: 'postgres' | 'mysql'
  wasValueSaved: (db: DbAdapter, dbType: 'postgres' | 'mysql', table: string, column: string, value: string) => Promise<boolean>
  wasValueAbsent: (db: DbAdapter, dbType: 'postgres' | 'mysql', table: string, column: string, value: string) => Promise<boolean>
  /** JSON field holding the created id in the POST response (default 'id'). */
  idField?: string
}

const isOk = (status: number): boolean => status >= 200 && status < 300

/** Replace `:param` and `{param}` path segments with the concrete id. */
function fillPath(path: string, id: string): string {
  return path.replace(/\{[^}]+\}/g, id).replace(/:[A-Za-z_][A-Za-z0-9_]*/g, id)
}

function extractId(body: unknown, idField: string): string | null {
  if (body && typeof body === 'object') {
    const v = (body as Record<string, unknown>)[idField]
    if (v !== undefined && v !== null) return String(v)
  }
  return null
}

/**
 * Execute one entity's CRUD happy-path via the injected API client: POST create → PATCH update
 * → DELETE delete, verifying each step against the DB (exists / value / absence). A step that does
 * not succeed becomes a high-severity `crud` finding; successful create/update record their columns
 * as `savedColumns` (fed back into the behavior tx node's `saved`). Never throws — the whole entity
 * is wrapped so one failure doesn't abort a batch.
 */
export async function executeCrudPlan(
  plan: CrudPlan,
  deps: ExecuteCrudDeps,
): Promise<{ findings: VerifyFinding[]; result: CrudEntityResult }> {
  const idField = deps.idField ?? 'id'
  const findings: VerifyFinding[] = []
  const steps: CrudStepResult[] = []
  const savedColumns: string[] = []
  const route = plan.create ? normalizeRoute(`${plan.create.method} ${plan.create.path}`) : plan.entity

  try {
    if (!plan.create) {
      return { findings, result: { entity: plan.entity, route, steps, savedColumns } }
    }

    // --- CREATE ---
    const createResp = await deps.api.request(plan.create.method, plan.create.path, plan.body)
    if (!isOk(createResp.status)) {
      findings.push(crudFinding(plan.entity, 'create', `作成リクエストが失敗 (status ${createResp.status})`))
      steps.push({ step: 'create', route, ok: false, detail: `status ${createResp.status}`, dbProbed: false })
      return { findings, result: { entity: plan.entity, route, steps, savedColumns } }
    }

    // Verify a representative body column landed (if a DB is available).
    const [firstCol, firstVal] = Object.entries(plan.body)[0] ?? []
    if (deps.db && firstCol !== undefined) {
      const saved = await deps.wasValueSaved(deps.db, deps.dbType, plan.table, firstCol, String(firstVal))
      if (saved) {
        savedColumns.push(firstCol)
        steps.push({ step: 'create', route, ok: true, detail: `saved ${firstCol}`, savedColumns: [firstCol], dbProbed: true })
      } else {
        findings.push(crudFinding(plan.entity, 'create', `作成は 2xx だが DB に反映されていない (${plan.table}.${firstCol})`))
        steps.push({ step: 'create', route, ok: false, detail: 'not persisted', dbProbed: true })
      }
    } else {
      steps.push({ step: 'create', route, ok: true, detail: `status ${createResp.status} (DB未接続で status のみ)`, dbProbed: false })
    }

    // Need the created id for update/delete.
    const createBody = await createResp.json().catch(() => null)
    const id = extractId(createBody, idField)
    if (!id) {
      logger.warn({ entity: plan.entity }, 'crud execute: no id in create response — skipping update/delete')
      return { findings, result: { entity: plan.entity, route, steps, savedColumns } }
    }

    // --- UPDATE ---
    if (plan.update) {
      const updateRoute = normalizeRoute(`${plan.update.method} ${plan.update.path}`)
      const newValue = `crud-updated-${plan.update.updatableColumn}`
      const upResp = await deps.api.request(plan.update.method, fillPath(plan.update.path, id), { [plan.update.updatableColumn]: newValue })
      if (!isOk(upResp.status)) {
        findings.push(crudFinding(plan.entity, 'update', `更新リクエストが失敗 (status ${upResp.status})`))
        steps.push({ step: 'update', route: updateRoute, ok: false, detail: `status ${upResp.status}`, dbProbed: false })
      } else if (deps.db) {
        const changed = await deps.wasValueSaved(deps.db, deps.dbType, plan.table, plan.update.updatableColumn, newValue)
        if (changed) {
          savedColumns.push(plan.update.updatableColumn)
          steps.push({ step: 'update', route: updateRoute, ok: true, detail: `updated ${plan.update.updatableColumn}`, savedColumns: [plan.update.updatableColumn], dbProbed: true })
        } else {
          findings.push(crudFinding(plan.entity, 'update', `更新は 2xx だが値が変わっていない (${plan.table}.${plan.update.updatableColumn})`))
          steps.push({ step: 'update', route: updateRoute, ok: false, detail: 'value unchanged', dbProbed: true })
        }
      } else {
        steps.push({ step: 'update', route: updateRoute, ok: true, detail: `status ${upResp.status} (DB未接続で status のみ)`, dbProbed: false })
      }
    }

    // --- DELETE ---
    if (plan.delete) {
      const deleteRoute = normalizeRoute(`${plan.delete.method} ${plan.delete.path}`)
      const delResp = await deps.api.request(plan.delete.method, fillPath(plan.delete.path, id))
      if (!isOk(delResp.status)) {
        findings.push(crudFinding(plan.entity, 'delete', `削除リクエストが失敗 (status ${delResp.status})`))
        steps.push({ step: 'delete', route: deleteRoute, ok: false, detail: `status ${delResp.status}`, dbProbed: false })
      } else if (deps.db) {
        const gone = await deps.wasValueAbsent(deps.db, deps.dbType, plan.table, plan.idColumn, id)
        if (gone) {
          steps.push({ step: 'delete', route: deleteRoute, ok: true, detail: 'row removed', dbProbed: true })
        } else {
          findings.push(crudFinding(plan.entity, 'delete', `削除は 2xx だが行が残っている (${plan.table}.${plan.idColumn}=${id})`))
          steps.push({ step: 'delete', route: deleteRoute, ok: false, detail: 'row still present', dbProbed: true })
        }
      } else {
        steps.push({ step: 'delete', route: deleteRoute, ok: true, detail: `status ${delResp.status} (DB未接続で status のみ)`, dbProbed: false })
      }
    }
  } catch (err) {
    logger.warn({ err: String(err), entity: plan.entity }, 'crud execute: entity failed — continuing')
  }

  return { findings, result: { entity: plan.entity, route, steps, savedColumns } }
}
