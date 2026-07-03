# CRUD 能動実行（C+D）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development. Steps use checkbox syntax.

**Goal:** structure の method 対応ルートに API 駆動で POST→GET→PATCH→DELETE を叩き、DB プローブ（存在/値/不在）で成功パスを検証し、失敗を finding 化、`saved` を充填して boundary を roundtrip-ok にする。

**Architecture:** 純導出の crud-plan（C）→ 注入 API クライアント＋DB プローブで実行する crudExecutor（D）→ 成功オラクル→ emit の tx ノード `saved` 充填。破壊的なので explore と同じ seed/reseed ガードを流用。

**Tech Stack:** TypeScript ESM, vitest。DbAdapter=`{query(sql,params),close()}`。structure route node raw=`{kind,method,path,handler,entity,crud[]}`。

## Global Constraints

- ESM, `.js` 拡張子付き相対 import。不変更新。エラーは握って warn、全体を止めない。
- 破壊的実行は `launch.seed` あり or `--no-reseed` 明示が無ければ拒否（explore 流用）。
- SQL 識別子は `^[A-Za-z_][A-Za-z0-9_]*$` のみ（既存 dbProbe/introspect と同ガード）。
- 成功パス専用（reject 探索は既存 explore）。

## File Structure

- Create: `packages/behavior/src/services/crud/plan.ts` + `plan.test.ts` — crud-plan 純導出。
- Create: `packages/behavior/src/services/crud/oracle.ts` + `oracle.test.ts` — 成功オラクル（finding 生成）。
- Create: `packages/behavior/src/services/crud/execute.ts` + `execute.test.ts` — API 駆動ライフサイクル実行。
- Create: `packages/behavior/src/services/crud/types.ts` — 共有型（CrudPlan, CrudStepResult, ApiClient）。
- Modify: `packages/behavior/src/services/explore/dbProbe.ts` (+ dbProbe.test.ts) — `wasValueAbsent` 追加。
- Modify: `packages/behavior/src/emit.ts` (+ emit.test.ts) — `emitTransactionNodes(txs, runId, savedByRoute?)`。
- Modify: `packages/behavior/src/cli/index.ts` — `run --crud` 配線（後続タスク、既存 explore 配線踏襲）。

---

## Task 1: dbProbe.wasValueAbsent

**Files:** Modify `packages/behavior/src/services/explore/dbProbe.ts`, `dbProbe.test.ts`.

**Interfaces:** Produces `wasValueAbsent(db, dbType, table, column, value): Promise<boolean>`。

- [ ] Step 1: 失敗テストを追記（`dbProbe.test.ts`）:
```ts
import { wasValueAbsent } from './dbProbe.js'
describe('wasValueAbsent', () => {
  const db = (rows: unknown[]) => ({ query: async () => rows, close: async () => {} })
  it('true when no rows', async () => {
    expect(await wasValueAbsent(db([]) as any, 'postgres', 'orders', 'id', '1')).toBe(true)
  })
  it('false when a row exists', async () => {
    expect(await wasValueAbsent(db([{ '1': 1 }]) as any, 'postgres', 'orders', 'id', '1')).toBe(false)
  })
  it('false (not asserting absence) on bad identifier', async () => {
    expect(await wasValueAbsent(db([]) as any, 'postgres', 'bad-table', 'id', '1')).toBe(false)
  })
})
```
- [ ] Step 2: `pnpm --filter @crawl-kit/behavior test dbProbe` → FAIL。
- [ ] Step 3: 実装（`wasValueSaved` の隣に）:
```ts
/** True if NO row exists in `table` where `column` = `value` (deletion confirmed). Never throws; false on error/bad ident (does not assert absence). */
export async function wasValueAbsent(
  db: DbAdapter, dbType: 'postgres' | 'mysql', table: string, column: string, value: string,
): Promise<boolean> {
  if (!IDENT.test(table) || !IDENT.test(column)) {
    logger.warn({ table, column }, 'wasValueAbsent: non-identifier — refusing to query')
    return false
  }
  const placeholder = dbType === 'postgres' ? '$1' : '?'
  const sql = `SELECT 1 FROM ${table} WHERE ${column} = ${placeholder} LIMIT 1`
  try {
    const rows = await db.query(sql, [value])
    return rows.length === 0
  } catch (err) {
    logger.warn({ err: String(err), table, column }, 'wasValueAbsent: query failed — not asserting absence')
    return false
  }
}
```
- [ ] Step 4: test → PASS。
- [ ] Step 5: Commit `feat: add wasValueAbsent DB probe for deletion verification`。

---

## Task 2: crud/types.ts

**Files:** Create `packages/behavior/src/services/crud/types.ts`.

**Interfaces:** Produces `CrudPlan`, `CrudEndpoint`, `CrudStepResult`, `CrudEntityResult`, `ApiClient`, `ApiResponse`。

- [ ] Step 1: 型を書く:
```ts
export type CrudEndpoint = { method: string; path: string }
export type CrudPlan = {
  entity: string
  table: string
  idColumn: string
  create?: CrudEndpoint
  update?: CrudEndpoint & { updatableColumn: string }
  delete?: CrudEndpoint
  body: Record<string, unknown>
}
export type ApiResponse = { status: number; json(): Promise<unknown>; text(): Promise<string> }
export type ApiClient = { request(method: string, url: string, body?: unknown): Promise<ApiResponse> }
export type CrudStep = 'create' | 'update' | 'delete'
export type CrudStepResult = { step: CrudStep; ok: boolean; detail: string; savedColumns?: string[] }
export type CrudEntityResult = { entity: string; route: string; steps: CrudStepResult[]; savedColumns: string[] }
```
- [ ] Step 2: `pnpm --filter @crawl-kit/behavior build` → PASS。
- [ ] Step 3: Commit `feat: crud shared types`。

---

## Task 3: crud/plan.ts（C: 純導出）

**Files:** Create `plan.ts`, `plan.test.ts`.

**Interfaces:** Consumes `LayerNode`(structure), `ColumnDef`, `CrudPlan`. Produces `buildCrudPlans(structureNodes, columnsByTable, bodyByTable?): CrudPlan[]`。
- `structureNodes`: structure LayerNode[]（raw.method/path/entity/crud）。
- `columnsByTable`: `Record<string, ColumnDef[]>`（introspection 結果、呼び出し側で用意）。
- `bodyByTable?`: 観測 POST ボディ形やフォーム由来の推奨ボディ（任意、優先採用）。

導出規則:
- entity(=table) ごとに structure route を集約。`hasIdParam(path)` = `/:`,`{`,`:id` を含む。
- create=POST route（id param 無し優先）。update=PATCH/PUT かつ id param 有り。delete=DELETE かつ id param 有り。
- idColumn = 列に `id` があれば `id`、無ければ最初の NOT NULL 列。無ければ entity をスキップ。
- create が無い entity はスキップ。
- body = `bodyByTable[table]` があればそれ、無ければ挿入可能列（id/`created_at`/`updated_at` 除外）に `placeholderValue(col)` を敷く。
- updatableColumn = 更新可能列（nullable でない or 任意の非 id/timestamp な文字列/数値列を1つ）。

- [ ] Step 1: 失敗テスト（代表例）:
```ts
import { buildCrudPlans } from './plan.js'
import type { LayerNode } from '@crawl-kit/contract'
const sn = (method: string, path: string, entity: string, crud: string[]): LayerNode => ({
  nodeId: `structure:route/${method} ${path}`, layer: 'structure', localName: `${method} ${path}`,
  route: `${method} ${path}`, raw: { kind: 'route', method, path, entity, crud }, source: { tool: 'rdra' },
})
const cols = { orders: [
  { name: 'id', dataType: 'integer', nullable: false },
  { name: 'title', dataType: 'text', nullable: false },
  { name: 'created_at', dataType: 'timestamp', nullable: false },
] }
describe('buildCrudPlans', () => {
  it('derives create/update/delete + idColumn + body for an entity', () => {
    const plans = buildCrudPlans([
      sn('POST', '/orders', 'orders', ['C']),
      sn('PATCH', '/orders/:id', 'orders', ['U']),
      sn('DELETE', '/orders/:id', 'orders', ['D']),
    ], cols as any)
    expect(plans).toHaveLength(1)
    const p = plans[0]
    expect(p.create).toEqual({ method: 'POST', path: '/orders' })
    expect(p.update?.path).toBe('/orders/:id')
    expect(p.delete?.method).toBe('DELETE')
    expect(p.idColumn).toBe('id')
    expect(Object.keys(p.body)).toContain('title')
    expect(Object.keys(p.body)).not.toContain('id')
    expect(Object.keys(p.body)).not.toContain('created_at')
  })
  it('skips entities with no create route', () => {
    expect(buildCrudPlans([sn('DELETE', '/orders/:id', 'orders', ['D'])], cols as any)).toHaveLength(0)
  })
  it('prefers bodyByTable when provided', () => {
    const plans = buildCrudPlans([sn('POST', '/orders', 'orders', ['C'])], cols as any, { orders: { title: 'Observed' } })
    expect(plans[0].body).toEqual({ title: 'Observed' })
  })
})
```
- [ ] Step 2: test → FAIL。
- [ ] Step 3: 実装（規則どおり。`placeholderValue(col)`: text→`"crud-<col>"`, integer/number→`1`, boolean→`true`, else→`"1"`。updatableColumn: id/timestamp/idColumn 以外の最初の列）。
- [ ] Step 4: test → PASS。
- [ ] Step 5: Commit `feat: derive CRUD plans from structure routes + db columns`。

---

## Task 4: crud/oracle.ts（成功オラクル）

**Files:** Create `oracle.ts`, `oracle.test.ts`.

**Interfaces:** Produces `crudFinding(entity, step, detail): VerifyFinding`（`category:'crud'`, severity high）。純関数。

- [ ] Step 1: 失敗テスト:
```ts
import { crudFinding } from './oracle.js'
it('creates a high crud finding', () => {
  const f = crudFinding('orders', 'delete', '行が残っている')
  expect(f.category).toBe('crud'); expect(f.severity).toBe('high')
  expect(f.title).toContain('delete'); expect(f.detail).toContain('行が残っている')
})
```
- [ ] Step 2: FAIL。
- [ ] Step 3: 実装。`VerifyFinding` の `category` に `'crud'` を許すため `domain/types.ts` の該当 union に `'crud'` を追加。
```ts
export function crudFinding(entity: string, step: string, detail: string): VerifyFinding {
  return { category: 'crud', severity: 'high', title: `CRUD ${step} 失敗: ${entity}`, detail, evidence: `entity=${entity} step=${step}` }
}
```
- [ ] Step 4: PASS。
- [ ] Step 5: Commit `feat: crud oracle finding + 'crud' verify category`。

---

## Task 5: crud/execute.ts（D: ライフサイクル実行）

**Files:** Create `execute.ts`, `execute.test.ts`.

**Interfaces:** Consumes `CrudPlan`, `ApiClient`, `DbAdapter`, `wasValueSaved`, `wasValueAbsent`, `crudFinding`. Produces `executeCrudPlan(plan, deps): Promise<{ findings: VerifyFinding[]; result: CrudEntityResult }>`。
`deps = { api: ApiClient; db?: DbAdapter; dbType: 'postgres'|'mysql'; wasValueSaved; wasValueAbsent; idField?: string }`。

手順（`fillPath(path, id)` = `:id`/`{id}` を id で置換）:
1. `POST create.path` body=plan.body。status 2xx でなければ create 失敗 finding、以降中断。
2. 作成 id = 応答 JSON の `idField`(既定 `id`) → 無ければ DB `SELECT MAX(idColumn)`（呼び出し側 db 経由。ここでは応答優先、テストは応答で）。
3. create 検証: `wasValueSaved(db, table, <body の代表列>, <値>)` が true → savedColumns に足す。false → 失敗 finding。
4. update があれば `PATCH fillPath(update.path,id)` body=`{[updatableColumn]: newValue}`。DB で該当 id 行の updatableColumn===newValue を確認（wasValueSaved を updatableColumn/newValue で流用）。
5. delete があれば `DELETE fillPath(delete.path,id)`。`wasValueAbsent(db, table, idColumn, id)` true → OK、false → 失敗 finding。
- db 未接続時は DB 検証をスキップし status のみで判定（warn）。

- [ ] Step 1: 失敗テスト（フェイク api/db）:
```ts
import { executeCrudPlan } from './execute.js'
const okResp = (status: number, body: unknown = {}) => ({ status, json: async () => body, text: async () => JSON.stringify(body) })
function fakeApi(seq: Record<string,{status:number,body?:unknown}>) {
  const calls: string[] = []
  return { calls, request: async (m: string, u: string) => { calls.push(`${m} ${u}`); const k = m; const r = seq[k] ?? { status: 200 }; return okResp(r.status, r.body) } }
}
const plan = { entity:'orders', table:'orders', idColumn:'id',
  create:{method:'POST',path:'/orders'}, update:{method:'PATCH',path:'/orders/:id',updatableColumn:'title'},
  delete:{method:'DELETE',path:'/orders/:id'}, body:{ title:'X' } }
it('runs create→update→delete happy path with no findings', async () => {
  const api = fakeApi({ POST:{status:201,body:{id:7}}, PATCH:{status:200}, DELETE:{status:204} })
  let deleted = false
  const db = { query: async (sql: string) => {
    if (/SELECT 1/.test(sql) && deleted) return []      // absence after delete
    return [{ '1': 1 }]                                   // exists otherwise
  }, close: async () => {} }
  const ws = async () => true
  const wa = async () => { deleted = true; return true }
  const { findings, result } = await executeCrudPlan(plan as any, { api: api as any, db: db as any, dbType:'postgres', wasValueSaved: ws as any, wasValueAbsent: wa as any })
  expect(findings).toHaveLength(0)
  expect(api.calls).toEqual(['POST /orders','PATCH /orders/7','DELETE /orders/7'])
  expect(result.savedColumns.length).toBeGreaterThan(0)
})
it('emits a finding when delete leaves the row', async () => {
  const api = fakeApi({ POST:{status:201,body:{id:7}}, PATCH:{status:200}, DELETE:{status:200} })
  const { findings } = await executeCrudPlan(plan as any, { api: api as any, db: { query: async()=>[{}], close: async()=>{} } as any, dbType:'postgres', wasValueSaved: (async()=>true) as any, wasValueAbsent: (async()=>false) as any })
  expect(findings.some(f => f.detail.includes('削除'))).toBe(true)
})
```
- [ ] Step 2: FAIL。
- [ ] Step 3: 実装（手順どおり、entity 単位 try/catch、fillPath、id 応答優先）。
- [ ] Step 4: PASS。
- [ ] Step 5: Commit `feat: API-driven CRUD lifecycle executor with success oracle`。

---

## Task 6: emit saved 充填

**Files:** Modify `emit.ts`, `emit.test.ts`.

**Interfaces:** `emitTransactionNodes(txs, runId?, savedByRoute?: Record<string,string[]>)`。route キー（normalizeRoute）一致で `raw.saved` を載せる。`emitBehaviorAll(...,txs, savedByRoute?)` も後方互換で追加。

- [ ] Step 1: 失敗テスト:
```ts
it('fills raw.saved from savedByRoute', () => {
  const nodes = emitTransactionNodes([tx({})], 'r', { 'POST /api/orders': ['title'] })
  expect((nodes[0].raw as any).saved).toEqual(['title'])
})
```
- [ ] Step 2: FAIL。
- [ ] Step 3: 実装（`byKey` 構築時、`savedByRoute?.[key]` があれば `raw.saved` に設定）。
- [ ] Step 4: PASS（既存 emit テストも緑）。
- [ ] Step 5: Commit `feat: fill behavior tx node saved from crud results`。

---

## Task 7: CLI 配線 `run --crud`

**Files:** Modify `packages/behavior/src/cli/index.ts`（`run` に `--crud` オプション）。既存 `run --explore` 配線（authed context, recorder, seed/reseed guard, createDbAdapter, introspectTable）を踏襲。

- [ ] Step 1: `--crud` オプション追加＋ガード（seed or --no-reseed 無ければ throw）。
- [ ] Step 2: authed context の `page.request` を `ApiClient` にアダプト（`request(m,u,body)=>page.request.fetch(u,{method:m,data:body})` 相当。BrowserLike に request が無ければ最小アダプタを注入）。
- [ ] Step 3: structure ルート（`data/structure.nodes.json` を ingest）＋ introspectTable で columnsByTable を作り `buildCrudPlans` → `executeCrudPlan` を各 plan で実行 → findings を writeFindings、savedByRoute を集約。
- [ ] Step 4: 実行後 `seedDatabase` で復元（explore と同じ）。
- [ ] Step 5: ビルド。Commit `feat: wire run --crud (guarded, authed API client, reseed)`。

---

## Task 8: 全体ビルド＋テスト緑

- [ ] Step 1: `pnpm -r build` → 成功。
- [ ] Step 2: `pnpm -r test` → 全緑（crud plan/oracle/execute, dbProbe, emit 新規含む）。
- [ ] Step 3: Commit（あれば）`chore: C+D green`。

## Self-Review

- Spec C（事前解析）→ Task 3。D（実行/オラクル/absence/saved）→ Task 1,4,5,6。CLI/ガード→ Task 7。型→ Task 2。全網羅。
- Placeholder 無し（各 step に実コード or 明確規則）。
- 型整合: `CrudPlan`/`ApiClient`/`CrudEntityResult`(Task2) を Task3/5 で使用。`wasValueAbsent`(Task1) を Task5 で使用。`crudFinding`(Task4) を Task5 で使用。`emitTransactionNodes` 追加引数(Task6) を Task7 で使用。
- リスク: Task7 の `page.request` アダプタは BrowserLike の実体に合わせ調整（無ければ最小 fetch アダプタ注入）。API ボディのフィールド名と DB 列名の差異は body 導出の優先順位（観測ボディ→フォーム→DB列）で緩和（spec 記載）。
