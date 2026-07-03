/** An HTTP endpoint (method + templated path) for one CRUD operation. */
export type CrudEndpoint = { method: string; path: string }

/** A derived plan for exercising one entity's CRUD happy-path. */
export type CrudPlan = {
  entity: string
  table: string
  idColumn: string
  create?: CrudEndpoint
  update?: CrudEndpoint & { updatableColumn: string }
  delete?: CrudEndpoint
  /** request body for the create call (field name → value). */
  body: Record<string, unknown>
}

/** Minimal HTTP client the executor drives (injected; Playwright request adapter or a fake). */
export type ApiResponse = { status: number; json(): Promise<unknown>; text(): Promise<string> }
export type ApiClient = { request(method: string, url: string, body?: unknown): Promise<ApiResponse> }

/** Per-run artifact mapping normalized route → columns confirmed saved (feeds emit's tx `saved`). */
export const CRUD_SAVED_SUFFIX = '.crud-saved.json'

/** Per-run artifact: the full CrudEntityResult[] (each step's own route + oracle ok), feeds
 *  emit's tx `persisted` verdict via tx-persistence.ts#annotatePersistence. */
export const CRUD_RESULTS_SUFFIX = '.crud-results.json'

export type CrudStep = 'create' | 'update' | 'delete'
/** `route` is the normalized "METHOD /path" this specific step ran against (create/update/delete
 *  each have their own path) — the match key tx-persistence.ts uses to annotate tx nodes.
 *  `dbProbed` is true only when execute.ts actually checked the DB for this step (a DbAdapter
 *  was available); false means `ok` reflects HTTP status alone (no DB adapter, or the request
 *  itself failed before a DB check could run) — tx-persistence.ts uses this to distinguish a
 *  confirmed "no" from an unverified mutation ("unknown"). */
export type CrudStepResult = { step: CrudStep; ok: boolean; detail: string; savedColumns?: string[]; route?: string; dbProbed: boolean }
/** `route` here is the entity's create route — kept for the existing `saved` (savedByRoute)
 *  feature. Per-operation matching (tx-persistence.ts) uses each step's own `route` instead. */
export type CrudEntityResult = { entity: string; route: string; steps: CrudStepResult[]; savedColumns: string[] }
