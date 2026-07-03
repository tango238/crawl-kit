# behavior CRUD/API 観測基盤（A+B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 実行中アプリの同一オリジン API 通信を漏れなく記録し（req/res をマスク＋キャップして jsonl 化）、レポートと viewer で見えるようにし、emit→boundary の永続化配線を method 対応で復活させる。

**Architecture:** Playwright の page イベントに付く共有 Recorder が同一オリジン API を `.e2e/runs/<runId>.transactions.jsonl` へ追記。behavior emit が最新 run の transactions から method 対応 behavior ノードを出し、jsonl を `data/behavior.transactions.jsonl` に橋渡し。report は決定的な要約表を追加、viewer は data/ の jsonl を配信して SPA が動的全件表示。

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspace, vitest, Playwright（behavior のブラウザ駆動）, 依存ゼロの Node http（viewer）。

## Global Constraints

- ESM のみ。相対 import は拡張子 `.js` 付き（例 `./mask.js`）。Node >= 20。
- 不変更新（ミューテーション禁止）。新オブジェクトを返す。
- 秘匿情報は必ず既存 `maskSecrets(text: string, secrets: string[])`（`packages/behavior/src/util/mask.js`）で伏字にしてから永続化。
- ボディは既定 `bodyCapBytes = 32768`（32KB）で truncate ＋ `*Truncated: true`。
- Recorder / jsonl 追記はベストエフォート: 例外は握って `logger.warn` どまり、クロール本体を止めない。
- テストは vitest（`pnpm --filter <pkg> test`）。既存パターンに合わせる。
- data/ の場所は `dataPath(name)`（`@crawl-kit/contract`）で解決。behavior の状態は `statePaths(root)`（`.e2e/...`）。
- 本 plan の非対象（C/D 送り）: 能動 CRUD executor、入力導出の事前解析、DELETE 実行/absence 判定、`saved` の実充填、`boundary.ts` の "D" 対応。

---

## File Structure

- Create: `packages/behavior/src/services/browser/recorder.ts` — API トランザクション Recorder（page 配線＋マスク＋キャップ＋jsonl 追記）。
- Create: `packages/behavior/src/services/browser/recorder.test.ts`
- Create: `packages/behavior/src/domain/transaction.ts` — `ApiTransaction` 型と定数（共有）。
- Create: `packages/behavior/src/pipeline/txSummary.ts` — transactions.jsonl → 決定的要約 Markdown。
- Create: `packages/behavior/src/pipeline/txSummary.test.ts`
- Modify: `packages/behavior/src/emit.ts` — transactions 由来の method 対応 behavior ノードを追加、`saved`/`method` を raw に載せる受け皿。
- Modify: `packages/behavior/src/emit.test.ts` — method 対応ノードのテスト追加。
- Modify: `packages/behavior/src/pipeline/emit.ts`（`runEmit`）— 最新 run の transactions を読み emit に渡し、`data/behavior.transactions.jsonl` へ橋渡し。
- Modify: `packages/behavior/src/pipeline/report.ts` — 「API 通信ログ」セクションと `report.json` の集計を追加。
- Modify: `packages/behavior/src/cli/index.ts` / `cli/commands/*` — ページ生成経路に `recorder.attach` を一本化（explore/run/crawl/login）。
- Modify: `packages/contract/src/paths.ts` — `DATA_FILES.behaviorTransactions = "behavior.transactions.jsonl"`。
- Modify: `packages/viewer/src/server.ts` — `/transactions.jsonl` エンドポイント。
- Modify: `packages/viewer/src/server.test.ts`（無ければ Create）— エンドポイントのテスト。
- Modify: `packages/viewer/index.html` — 「通信ログ (API)」タブ（fetch 動的全件表示＋クライアントフィルタ）。
- Modify: `e2e.config.yaml`（サンプル）＋ `docs/OPERATIONS.md` — DB 接続の足し方。
- Add test: `packages/verification/src/boundary.test.ts` — method 対応ペアリング＋`saved` の確認（既存受け皿の回帰）。

**既に判明している事実（実装前提）:**
- `normalizeRoute`（`packages/reconciler/src/match/route.ts:29`）は `"METHOD /path"` を既に正規化する（method 大文字化、空白なしは GET 既定、id 断片は `:id`）。→ reconciler/boundary の照合は method 対応済み。GET 固定は `emit.ts:25` の producer 側だけ。
- `boundary.ts:184` は既に `if (r.saved !== undefined) b.saved = strList(r.saved)` と `saved` を読み、route は `normalizeRoute` で method 込みに正規化する。→ 受け皿は存在。A-2 は producer(emit) 修正＋確認テストのみ。
- `runEmit`（`packages/behavior/src/pipeline/emit.ts:17`）は `loadLatestReport(root)` の SiteStructure を `emitBehaviorAll(structure)` して `dataPath(DATA_FILES.behaviorNodes)` に書く。
- run の SiteStructure は `.e2e/runs/<runId>.yaml`（`state/store.ts:17`）。transactions は sibling の `.e2e/runs/<runId>.transactions.jsonl` に置く。
- `LayerNode` 形状（`emit.ts` 実使用）: `{ nodeId, layer:'behavior', localName, raw, route, source:{tool, runId?} }`。

---

## Task 1: `ApiTransaction` 型 ＋ `DATA_FILES` 追加

**Files:**
- Create: `packages/behavior/src/domain/transaction.ts`
- Modify: `packages/contract/src/paths.ts:34-43`

**Interfaces:**
- Produces: `ApiTransaction`（下記フィールド）、`RECORD_STAGES`、`DEFAULT_BODY_CAP_BYTES`。`DATA_FILES.behaviorTransactions`。

- [ ] **Step 1: 型ファイルを書く**

`packages/behavior/src/domain/transaction.ts`:
```ts
/** One recorded same-origin API request/response, persisted as one jsonl line. */
export type ApiTransaction = {
  runId: string
  seq: number
  ts: string
  durationMs: number
  stage: RecordStage
  method: string
  url: string
  path: string
  resourceType: string
  requestQuery?: Record<string, string>
  requestBody?: string
  requestBodyTruncated?: boolean
  status?: number
  statusText?: string
  responseBody?: string
  responseBodyTruncated?: boolean
  ok: boolean
  failed?: boolean
  errorText?: string
}

export type RecordStage = 'crawl' | 'explore' | 'scenario' | 'login'
export const DEFAULT_BODY_CAP_BYTES = 32768
export const TRANSACTIONS_SUFFIX = '.transactions.jsonl'
```

- [ ] **Step 2: `DATA_FILES` に追加**

`packages/contract/src/paths.ts` の `DATA_FILES` オブジェクトに 1 行足す（`acquisition` の下）:
```ts
  acquisition: "acquisition.json",
  behaviorTransactions: "behavior.transactions.jsonl",
} as const;
```

- [ ] **Step 3: ビルド確認**

Run: `pnpm --filter @crawl-kit/contract build && pnpm --filter @crawl-kit/behavior build`
Expected: 型エラーなしで成功。

- [ ] **Step 4: Commit**

```bash
git add packages/behavior/src/domain/transaction.ts packages/contract/src/paths.ts
git commit -m "feat: add ApiTransaction type and behaviorTransactions data file"
```

---

## Task 2: Recorder（捕捉・マスク・キャップ・jsonl 追記）

**Files:**
- Create: `packages/behavior/src/services/browser/recorder.ts`
- Test: `packages/behavior/src/services/browser/recorder.test.ts`

**Interfaces:**
- Consumes: `ApiTransaction`, `RecordStage`, `DEFAULT_BODY_CAP_BYTES`, `TRANSACTIONS_SUFFIX`（Task 1）、`maskSecrets`（`util/mask.js`）、`statePaths`（`state/paths.js`）。
- Produces:
  - `createRecorder(opts: RecorderOptions): Recorder`
  - `type RecorderOptions = { runId: string; root: string; baseUrl: string; secrets: string[]; bodyCapBytes?: number }`
  - `type Recorder = { attach(page: RecorderPage, stage: RecordStage): void; path: string }`
  - `type RecorderPage = { on(event: 'requestfinished' | 'requestfailed', cb: (req: RecRequest) => void): void }`
  - `type RecRequest = { url(): string; method(): string; resourceType(): string; postData(): string | null; failure?(): { errorText: string } | null; response(): Promise<RecResponse | null> }`
  - `type RecResponse = { status(): number; statusText(): string; text(): Promise<string> }`
  - `sameOrigin(url: string, baseUrl: string): boolean` と `isApiResourceType(t: string): boolean` と `capBody(s: string, cap: number): { body: string; truncated: boolean }`（テスト用に export）

- [ ] **Step 1: 失敗するテストを書く**

`packages/behavior/src/services/browser/recorder.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecorder, sameOrigin, isApiResourceType, capBody } from './recorder.js'
import type { ApiTransaction } from '../../domain/transaction.js'

type Cb = (req: any) => void

function fakePage() {
  const handlers: Record<string, Cb[]> = { requestfinished: [], requestfailed: [] }
  return {
    on: (e: 'requestfinished' | 'requestfailed', cb: Cb) => handlers[e].push(cb),
    emitFinished: (req: any) => handlers.requestfinished.forEach((h) => h(req)),
    emitFailed: (req: any) => handlers.requestfailed.forEach((h) => h(req)),
  }
}

function req(over: Partial<any>) {
  return {
    url: () => 'http://app.test/api/orders',
    method: () => 'POST',
    resourceType: () => 'fetch',
    postData: () => '{"name":"x"}',
    failure: () => null,
    response: async () => ({ status: () => 201, statusText: () => 'Created', text: async () => '{"id":1}' }),
    ...over,
  }
}

async function lines(path: string): Promise<ApiTransaction[]> {
  const txt = await readFile(path, 'utf8').catch(() => '')
  return txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

describe('recorder helpers', () => {
  it('sameOrigin matches host+scheme, ignores path', () => {
    expect(sameOrigin('http://app.test/api/x', 'http://app.test')).toBe(true)
    expect(sameOrigin('http://other.test/x', 'http://app.test')).toBe(false)
  })
  it('isApiResourceType allows xhr/fetch/document only', () => {
    expect(isApiResourceType('fetch')).toBe(true)
    expect(isApiResourceType('xhr')).toBe(true)
    expect(isApiResourceType('document')).toBe(true)
    expect(isApiResourceType('image')).toBe(false)
    expect(isApiResourceType('stylesheet')).toBe(false)
  })
  it('capBody truncates over the cap and flags it', () => {
    const r = capBody('abcdef', 3)
    expect(r).toEqual({ body: 'abc', truncated: true })
    expect(capBody('ab', 3)).toEqual({ body: 'ab', truncated: false })
  })
})

describe('createRecorder', () => {
  it('records a same-origin API POST with masked+capped bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'run1', root, baseUrl: 'http://app.test', secrets: ['topsecret'], bodyCapBytes: 1000 })
    const page = fakePage()
    rec.attach(page as any, 'explore')
    page.emitFinished(req({ postData: () => '{"pw":"topsecret"}' }))
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows).toHaveLength(1)
    expect(rows[0].method).toBe('POST')
    expect(rows[0].path).toBe('/api/orders')
    expect(rows[0].status).toBe(201)
    expect(rows[0].ok).toBe(true)
    expect(rows[0].stage).toBe('explore')
    expect(rows[0].requestBody).not.toContain('topsecret')
    expect(rows[0].requestBody).toContain('***')
  })

  it('skips static assets and cross-origin requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'r', root, baseUrl: 'http://app.test', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'crawl')
    page.emitFinished(req({ resourceType: () => 'image', url: () => 'http://app.test/logo.png' }))
    page.emitFinished(req({ url: () => 'http://cdn.other/x.js', resourceType: () => 'fetch' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(await lines(rec.path)).toHaveLength(0)
  })

  it('records a failed request with failed=true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'r', root, baseUrl: 'http://app.test', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'scenario')
    page.emitFailed(req({ failure: () => ({ errorText: 'net::ERR_ABORTED' }), response: async () => null }))
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows[0].failed).toBe(true)
    expect(rows[0].ok).toBe(false)
    expect(rows[0].errorText).toBe('net::ERR_ABORTED')
  })
})
```

- [ ] **Step 2: テストが落ちるのを確認**

Run: `pnpm --filter @crawl-kit/behavior test recorder`
Expected: FAIL（`recorder.js` が無い / export 未定義）。

- [ ] **Step 3: 実装を書く**

`packages/behavior/src/services/browser/recorder.ts`:
```ts
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '../../util/logger.js'
import { maskSecrets } from '../../util/mask.js'
import { statePaths } from '../../state/paths.js'
import { DEFAULT_BODY_CAP_BYTES, TRANSACTIONS_SUFFIX } from '../../domain/transaction.js'
import type { ApiTransaction, RecordStage } from '../../domain/transaction.js'

export type RecorderOptions = {
  runId: string
  root: string
  baseUrl: string
  secrets: string[]
  bodyCapBytes?: number
}

export type RecResponse = { status(): number; statusText(): string; text(): Promise<string> }
export type RecRequest = {
  url(): string
  method(): string
  resourceType(): string
  postData(): string | null
  failure?(): { errorText: string } | null
  response(): Promise<RecResponse | null>
}
export type RecorderPage = {
  on(event: 'requestfinished' | 'requestfailed', cb: (req: RecRequest) => void): void
}
export type Recorder = { attach(page: RecorderPage, stage: RecordStage): void; path: string }

const API_TYPES = new Set(['xhr', 'fetch', 'document'])
export function isApiResourceType(t: string): boolean {
  return API_TYPES.has(t)
}

export function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

export function capBody(s: string, cap: number): { body: string; truncated: boolean } {
  if (s.length <= cap) return { body: s, truncated: false }
  return { body: s.slice(0, cap), truncated: true }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

function queryOf(url: string): Record<string, string> | undefined {
  try {
    const q = new URL(url).searchParams
    const out: Record<string, string> = {}
    for (const [k, v] of q) out[k] = v
    return Object.keys(out).length ? out : undefined
  } catch {
    return undefined
  }
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const cap = opts.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES
  const path = join(statePaths(opts.root).runs, `${opts.runId}${TRANSACTIONS_SUFFIX}`)
  let seq = 0
  let ensured = false

  const mask = (s: string): string => maskSecrets(s, opts.secrets)

  async function write(tx: ApiTransaction): Promise<void> {
    try {
      if (!ensured) {
        await mkdir(dirname(path), { recursive: true })
        ensured = true
      }
      await appendFile(path, `${JSON.stringify(tx)}\n`, 'utf8')
    } catch (err) {
      logger.warn({ err: String(err) }, 'recorder: append failed — continuing')
    }
  }

  async function record(req: RecRequest, stage: RecordStage, failed: boolean): Promise<void> {
    try {
      const url = req.url()
      if (!sameOrigin(url, opts.baseUrl)) return
      if (!isApiResourceType(req.resourceType())) return

      const rawReqBody = req.postData() ?? undefined
      const reqCap = rawReqBody != null ? capBody(mask(rawReqBody), cap) : undefined

      let status: number | undefined
      let statusText: string | undefined
      let respCap: { body: string; truncated: boolean } | undefined
      if (!failed) {
        const res = await req.response().catch(() => null)
        if (res) {
          status = res.status()
          statusText = res.statusText()
          const body = await res.text().catch(() => '')
          if (body) respCap = capBody(mask(body), cap)
        }
      }
      const errText = failed ? (req.failure?.() ?? null)?.errorText : undefined

      const tx: ApiTransaction = {
        runId: opts.runId,
        seq: seq++,
        ts: new Date().toISOString(),
        durationMs: 0,
        stage,
        method: req.method().toUpperCase(),
        url: mask(url),
        path: pathOf(url),
        resourceType: req.resourceType(),
        requestQuery: queryOf(url),
        requestBody: reqCap?.body,
        requestBodyTruncated: reqCap?.truncated || undefined,
        status,
        statusText,
        responseBody: respCap?.body,
        responseBodyTruncated: respCap?.truncated || undefined,
        ok: status != null ? status >= 200 && status < 400 : false,
        failed: failed || undefined,
        errorText: errText || undefined,
      }
      await write(tx)
    } catch (err) {
      logger.warn({ err: String(err) }, 'recorder: record failed — continuing')
    }
  }

  return {
    path,
    attach(page: RecorderPage, stage: RecordStage): void {
      page.on('requestfinished', (req) => void record(req, stage, false))
      page.on('requestfailed', (req) => void record(req, stage, true))
    },
  }
}
```

- [ ] **Step 4: テストが通るのを確認**

Run: `pnpm --filter @crawl-kit/behavior test recorder`
Expected: PASS（全 6 ケース）。

- [ ] **Step 5: Commit**

```bash
git add packages/behavior/src/services/browser/recorder.ts packages/behavior/src/services/browser/recorder.test.ts
git commit -m "feat: add same-origin API transaction recorder"
```

---

## Task 3: 全ページ生成に Recorder を配線

**Files:**
- Modify: `packages/behavior/src/cli/index.ts`（`createPage`/`exCreatePage` の生成経路、runId が取れる箇所）
- Modify: `packages/behavior/src/cli/commands/explore.ts:87-101`（`createPage`）

**Interfaces:**
- Consumes: `createRecorder`（Task 2）。既存の `runId`・`config.targets[0].baseUrl`・`allSecrets`・`root(cwd)`。

**背景:** 現状 `createPage`（`cli/index.ts:87-101`, `cli/index.ts:328-337`）と explore コマンドの `createPage` は、mutating レスポンスの `lastStatus` だけを拾う個別リスナを付けている。ここへ Recorder.attach を追加する（`lastStatus` 用リスナは残してよい — 別目的）。

- [ ] **Step 1: explore コマンドの createPage に attach を足す**

`packages/behavior/src/cli/commands/explore.ts` の `createPage`（既存の response リスナの直後）:
```ts
    const recorder = createRecorder({
      runId,
      root: cwd,
      baseUrl: target.baseUrl,
      secrets: allSecrets,
    })
    const createPage = async () => {
      const page = await browserCtx.browser.newPage()
      const raw = page as unknown as {
        on?: (event: 'response', cb: (res: { status: () => number; request: () => { method: () => string } }) => void) => void
      }
      raw.on?.('response', (res) => {
        try {
          const method = res.request().method().toUpperCase()
          if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) lastStatus = res.status()
        } catch {
          /* ignore listener errors */
        }
      })
      recorder.attach(page as unknown as import('../../services/browser/recorder.js').RecorderPage, 'explore')
      return page
    }
```
ファイル先頭に import を追加:
```ts
import { createRecorder } from '../../services/browser/recorder.js'
```
（`runId` がこのスコープで未定義なら、既存の run 識別子を使う。無ければ `const runId = new Date().toISOString().replace(/[:.]/g, '-')` を createRecorder 直前に定義。）

- [ ] **Step 2: run 側 createPage / exCreatePage に attach を足す**

`packages/behavior/src/cli/index.ts` の 2 箇所（`createPage` ≈ 87-101、`exCreatePage` ≈ 328-337）で、`page` を返す前に stage 付きで attach:
```ts
      recorder.attach(page as unknown as import('../services/browser/recorder.js').RecorderPage, 'explore')
```
run 本体のクロール用 page には stage `'crawl'`、explore 用には `'explore'`。ファイル上部で 1 つ recorder を作る（`ctx.runId`・`config.targets[0].baseUrl`・`allSecrets`・`ctx.root` を使用）:
```ts
import { createRecorder } from '../services/browser/recorder.js'
// ... run のセットアップ内、runId/target/secrets が揃った後:
const recorder = createRecorder({ runId: ctx.runId, root: ctx.root, baseUrl: selectedTarget.baseUrl, secrets: allSecrets })
```

- [ ] **Step 3: crawl/login のページ生成経路にも通す**

crawl は `crawlWithBrowser`（`services/browser/crawler.ts`）がページを作る。attach を渡せるよう、crawl を呼ぶ箇所（`cli/index.ts` の `collect`/`recrawl`）で使う page ファクトリに recorder.attach を通す。login は同じ context のページを使うため、context 由来ページに attach 済みなら追加不要。**最小方針**: crawl 用 page ファクトリを recorder.attach でラップする（run 本体が page を作る箇所に一本化）。

- [ ] **Step 4: ビルド確認**

Run: `pnpm --filter @crawl-kit/behavior build`
Expected: 型エラーなし。

- [ ] **Step 5: Commit**

```bash
git add packages/behavior/src/cli/index.ts packages/behavior/src/cli/commands/explore.ts
git commit -m "feat: attach API recorder to all crawl/explore page factories"
```

---

## Task 4: emit — transactions から method 対応 behavior ノード

**Files:**
- Modify: `packages/behavior/src/emit.ts`
- Test: `packages/behavior/src/emit.test.ts`

**Interfaces:**
- Consumes: `ApiTransaction`（Task 1）、`LayerNode`。
- Produces: `emitTransactionNodes(txs: ApiTransaction[], runId?: string): LayerNode[]`。`emitBehaviorAll(structure, report?, runId?, txs?)` に第4引数 `txs?: ApiTransaction[]` を追加（省略時 [])。

**設計:** ページ（GET ナビゲーション）ノードは従来どおり。加えて **mutating な transaction（method ∈ POST/PUT/PATCH/DELETE）を route-keyed behavior ノードに**する（`POST /api/orders` 等）。`normalizeRoute` が method を保つので structure の method 付き route と照合される。`raw` に `method` と（あれば）`saved` を載せる受け皿を持たせる（A+B では `saved` は未供給＝載らない）。GET の重複ページノードは作らない（ページノードが既にある）。

- [ ] **Step 1: 失敗するテストを追加**

`packages/behavior/src/emit.test.ts` に追記:
```ts
import { emitTransactionNodes } from './emit.js'
import type { ApiTransaction } from './domain/transaction.js'

const tx = (over: Partial<ApiTransaction>): ApiTransaction => ({
  runId: 'r', seq: 0, ts: '2026-07-01T00:00:00Z', durationMs: 0, stage: 'explore',
  method: 'POST', url: 'http://app.test/api/orders', path: '/api/orders',
  resourceType: 'fetch', ok: true, status: 201, ...over,
})

describe('emitTransactionNodes', () => {
  it('emits a method-keyed behavior node for a mutating request', () => {
    const nodes = emitTransactionNodes([tx({})], 'r')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].route).toBe('POST /api/orders')
    expect(nodes[0].layer).toBe('behavior')
    expect(nodes[0].nodeId.startsWith('behavior:tx/')).toBe(true)
    expect((nodes[0].raw as any).method).toBe('POST')
  })
  it('ignores GET transactions (pages already cover navigations)', () => {
    expect(emitTransactionNodes([tx({ method: 'GET' })], 'r')).toHaveLength(0)
  })
  it('dedupes identical method+path, keeping one node', () => {
    const nodes = emitTransactionNodes([tx({ path: '/api/orders/1', url: 'http://app.test/api/orders/1' }), tx({ path: '/api/orders/2', url: 'http://app.test/api/orders/2' })], 'r')
    // both normalize to POST /api/orders/:id
    expect(nodes).toHaveLength(1)
    expect(nodes[0].route).toBe('POST /api/orders/:id')
  })
})
```
（`describe/it/expect` の import が未追加ならファイル先頭に足す。route の期待値は `normalizeRoute` に一致させる。）

- [ ] **Step 2: テストが落ちるのを確認**

Run: `pnpm --filter @crawl-kit/behavior test emit`
Expected: FAIL（`emitTransactionNodes` 未定義）。

- [ ] **Step 3: 実装を書く**

`packages/behavior/src/emit.ts` に追加（import に `normalizeRoute` と型を足す）:
```ts
import { normalizeRoute } from '@crawl-kit/reconciler'
import type { ApiTransaction } from './domain/transaction.js'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Emit method-aware behavior nodes from recorded API transactions. Page nodes
 * cover GET navigations; these cover mutations (POST/PUT/PATCH/DELETE) so the
 * reconciler/boundary can pair them with structure's method-keyed routes.
 * Deduped by normalized "METHOD /path" (id segments collapse to :id).
 */
export function emitTransactionNodes(txs: ApiTransaction[], runId?: string): LayerNode[] {
  const byKey = new Map<string, LayerNode>()
  for (const t of txs) {
    const method = t.method.toUpperCase()
    if (!MUTATING.has(method)) continue
    const key = normalizeRoute(`${method} ${t.path}`)
    if (byKey.has(key)) continue
    byKey.set(key, {
      nodeId: `behavior:tx/${key}`,
      layer: 'behavior' as const,
      localName: key,
      raw: {
        kind: 'transaction',
        method,
        path: t.path,
        status: t.status,
        ok: t.ok,
        // `saved` receptacle for C/D; unset in A+B (no active executor / DB probe).
      },
      route: key,
      source: { tool: TOOL, ...(runId ? { runId } : {}) },
    })
  }
  return [...byKey.values()]
}
```
`emitBehaviorAll` を拡張:
```ts
export function emitBehaviorAll(
  structure: SiteStructure,
  report: Report | null = null,
  runId?: string,
  txs: ApiTransaction[] = [],
): LayerNode[] {
  return [
    ...emitBehaviorNodes(structure, report, runId),
    ...emitBehaviorTransitionNodes(structure, runId),
    ...emitTransactionNodes(txs, runId),
  ]
}
```
`emitTransactionNodes` を `packages/behavior/src/index.ts` の re-export に追加。

- [ ] **Step 4: テストが通るのを確認**

Run: `pnpm --filter @crawl-kit/behavior test emit`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/behavior/src/emit.ts packages/behavior/src/emit.test.ts packages/behavior/src/index.ts
git commit -m "feat: emit method-aware behavior nodes from API transactions"
```

---

## Task 5: runEmit — transactions を読み emit へ渡し data/ へ橋渡し

**Files:**
- Modify: `packages/behavior/src/pipeline/emit.ts`

**Interfaces:**
- Consumes: `emitBehaviorAll(structure, report, runId, txs)`（Task 4）、`ApiTransaction`, `TRANSACTIONS_SUFFIX`（Task 1）、`DATA_FILES.behaviorTransactions`（Task 1）、`statePaths`、`loadLatestReport`。
- Produces: `runEmit` は従来の戻り値に加え、`data/behavior.transactions.jsonl` を書く（最新 run の transactions をコピー）。

- [ ] **Step 1: 実装を書く**

`packages/behavior/src/pipeline/emit.ts` を更新:
```ts
import { dirname, join, basename } from 'node:path'
import { mkdir, writeFile, readFile, readdir, stat, copyFile } from 'node:fs/promises'
import { DATA_FILES, dataPath } from '@crawl-kit/contract'
import { loadLatestReport } from '../../state/store.js'
import { statePaths } from '../../state/paths.js'
import { emitBehaviorAll } from '../../emit.js'
import { TRANSACTIONS_SUFFIX } from '../../domain/transaction.js'
import type { ApiTransaction } from '../../domain/transaction.js'
import { logger } from '../../util/logger.js'

export type RunEmitDeps = { loadConfig?: (root: string) => Promise<unknown> }
export type RunEmitResult = { count: number; outPath: string; transactions: number }

/** Find the newest *.transactions.jsonl in .e2e/runs (by mtime); [] if none. */
async function loadLatestTransactions(root: string): Promise<{ txs: ApiTransaction[]; file: string | null }> {
  const runsDir = statePaths(root).runs
  let files: string[]
  try {
    files = await readdir(runsDir)
  } catch {
    return { txs: [], file: null }
  }
  const cand = files.filter((f) => f.endsWith(TRANSACTIONS_SUFFIX))
  if (cand.length === 0) return { txs: [], file: null }
  const withMtime = await Promise.all(cand.map(async (f) => ({ f, m: (await stat(join(runsDir, f))).mtimeMs })))
  withMtime.sort((a, b) => a.m - b.m)
  const latest = withMtime[withMtime.length - 1].f
  const txt = await readFile(join(runsDir, latest), 'utf8').catch(() => '')
  const txs = txt.split('\n').filter((l) => l.trim()).flatMap((l) => {
    try { return [JSON.parse(l) as ApiTransaction] } catch { return [] }
  })
  return { txs, file: join(runsDir, latest) }
}

export async function runEmit(root: string, _deps: RunEmitDeps = {}): Promise<RunEmitResult> {
  const structure = await loadLatestReport(root)
  if (!structure) throw new Error('no run found — run `loop-e2e run` first')

  const { txs, file } = await loadLatestTransactions(root)
  const nodes = emitBehaviorAll(structure, null, undefined, txs)

  const outPath = dataPath(DATA_FILES.behaviorNodes)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(nodes, null, 2)}\n`, 'utf8')

  // Bridge the raw jsonl into data/ so the viewer (which only reads data/) can serve it.
  const txOut = dataPath(DATA_FILES.behaviorTransactions)
  if (file) {
    await copyFile(file, txOut).catch((err) => logger.warn({ err: String(err) }, 'emit: transaction bridge failed'))
  } else {
    await writeFile(txOut, '', 'utf8').catch(() => {})
  }

  return { count: nodes.length, outPath, transactions: txs.length }
}
```

- [ ] **Step 2: ビルド確認**

Run: `pnpm --filter @crawl-kit/behavior build`
Expected: 型エラーなし。

- [ ] **Step 3: 既存テストが壊れていないか確認**

Run: `pnpm --filter @crawl-kit/behavior test`
Expected: PASS（`runEmit` を呼ぶ既存テストがあれば戻り値追加に追随。無ければそのまま緑）。

- [ ] **Step 4: Commit**

```bash
git add packages/behavior/src/pipeline/emit.ts
git commit -m "feat: runEmit reads latest transactions and bridges jsonl to data/"
```

---

## Task 6: txSummary — 決定的な API 通信ログ要約

**Files:**
- Create: `packages/behavior/src/pipeline/txSummary.ts`
- Test: `packages/behavior/src/pipeline/txSummary.test.ts`

**Interfaces:**
- Consumes: `ApiTransaction`（Task 1）。
- Produces:
  - `summarizeTransactions(txs: ApiTransaction[]): TxSummary`
  - `type TxSummary = { total: number; byMethod: Record<string, number>; failures: ApiTransaction[] }`
  - `renderTransactionSection(txs: ApiTransaction[], jsonlRef: string): string`（Markdown。txs 空なら ''）

- [ ] **Step 1: 失敗するテストを書く**

`packages/behavior/src/pipeline/txSummary.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { summarizeTransactions, renderTransactionSection } from './txSummary.js'
import type { ApiTransaction } from '../domain/transaction.js'

const tx = (o: Partial<ApiTransaction>): ApiTransaction => ({
  runId: 'r', seq: 0, ts: 't', durationMs: 0, stage: 'explore', method: 'GET',
  url: 'http://a/x', path: '/x', resourceType: 'fetch', ok: true, status: 200, ...o,
})

describe('summarizeTransactions', () => {
  it('counts total and per-method, collects failures', () => {
    const s = summarizeTransactions([
      tx({ method: 'GET', status: 200, ok: true }),
      tx({ method: 'POST', status: 201, ok: true }),
      tx({ method: 'POST', status: 500, ok: false }),
      tx({ method: 'DELETE', failed: true, ok: false }),
    ])
    expect(s.total).toBe(4)
    expect(s.byMethod).toEqual({ GET: 1, POST: 2, DELETE: 1 })
    expect(s.failures).toHaveLength(2)
  })
})

describe('renderTransactionSection', () => {
  it('returns empty string for no transactions', () => {
    expect(renderTransactionSection([], 'x')).toBe('')
  })
  it('renders a header, counts, and a failure table', () => {
    const md = renderTransactionSection([tx({ method: 'POST', path: '/api/o', status: 500, ok: false })], '.e2e/runs/r.transactions.jsonl')
    expect(md).toContain('## API 通信ログ')
    expect(md).toContain('POST')
    expect(md).toContain('500')
    expect(md).toContain('.e2e/runs/r.transactions.jsonl')
  })
})
```

- [ ] **Step 2: テストが落ちるのを確認**

Run: `pnpm --filter @crawl-kit/behavior test txSummary`
Expected: FAIL。

- [ ] **Step 3: 実装を書く**

`packages/behavior/src/pipeline/txSummary.ts`:
```ts
import type { ApiTransaction } from '../domain/transaction.js'

export type TxSummary = { total: number; byMethod: Record<string, number>; failures: ApiTransaction[] }

export function summarizeTransactions(txs: ApiTransaction[]): TxSummary {
  const byMethod: Record<string, number> = {}
  const failures: ApiTransaction[] = []
  for (const t of txs) {
    byMethod[t.method] = (byMethod[t.method] ?? 0) + 1
    if (!t.ok) failures.push(t)
  }
  return { total: txs.length, byMethod, failures }
}

/** Deterministic Markdown section (no LLM → no secrets in prompts). '' if empty. */
export function renderTransactionSection(txs: ApiTransaction[], jsonlRef: string): string {
  if (txs.length === 0) return ''
  const s = summarizeTransactions(txs)
  const methods = Object.entries(s.byMethod).sort().map(([m, n]) => `${m} ${n}`).join(' / ')
  const failRows = s.failures
    .map((f) => `| ${f.method} | ${f.path} | ${f.status ?? (f.failed ? 'FAILED' : '-')} | ${f.stage} |`)
    .join('\n')
  const failTable = s.failures.length
    ? `\n\n**失敗 (${s.failures.length})**\n\n| method | path | status | stage |\n|---|---|---|---|\n${failRows}`
    : '\n\nすべて成功（非2xxなし）。'
  return `\n\n## API 通信ログ\n\n- 総リクエスト: ${s.total}\n- method 別: ${methods}\n- 生ログ: \`${jsonlRef}\`${failTable}`
}
```

- [ ] **Step 4: テストが通るのを確認**

Run: `pnpm --filter @crawl-kit/behavior test txSummary`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/behavior/src/pipeline/txSummary.ts packages/behavior/src/pipeline/txSummary.test.ts
git commit -m "feat: deterministic API transaction summary section"
```

---

## Task 7: report.ts に通信ログセクションを差し込む

**Files:**
- Modify: `packages/behavior/src/pipeline/report.ts`

**Interfaces:**
- Consumes: `renderTransactionSection`（Task 6）、`ApiTransaction`, `TRANSACTIONS_SUFFIX`（Task 1）、`statePaths`。
- 既存 `renderReport(root, runId, deps)` の Markdown 組み立て（`report.ts:261`）に通信ログ節を足し、`report.json` に `transactionsRef` を格納。

- [ ] **Step 1: transactions を読むヘルパを追加**

`report.ts` 上部に import と読取を追加:
```ts
import { readFile } from 'node:fs/promises'
import { statePaths } from '../state/paths.js'
import { TRANSACTIONS_SUFFIX } from '../domain/transaction.js'
import type { ApiTransaction } from '../domain/transaction.js'
import { renderTransactionSection } from './txSummary.js'

async function loadRunTransactions(root: string, runId: string): Promise<ApiTransaction[]> {
  const file = join(statePaths(root).runs, `${runId}${TRANSACTIONS_SUFFIX}`)
  const txt = await readFile(file, 'utf8').catch(() => '')
  return txt.split('\n').filter((l) => l.trim()).flatMap((l) => {
    try { return [JSON.parse(l) as ApiTransaction] } catch { return [] }
  })
}
```

- [ ] **Step 2: Markdown 組み立てに節を足す**

`report.ts:261` 付近の `mdContent` 生成を変更:
```ts
  const txs = await loadRunTransactions(root, runId)
  const txRef = `.e2e/runs/${runId}${TRANSACTIONS_SUFFIX}`
  const txSection = renderTransactionSection(txs, txRef)
  const mdContent = `${reportBody}${activitySection(activity)}${txSection}${uncertainSection}\n`
```
`report` オブジェクト（`report.ts:238`）に参照を追加:
```ts
    summary: reportBody,
    transactionsRef: txRef,
```
（`Report` 型に `transactionsRef?: string` を追加: `packages/behavior/src/domain/types.ts` の `Report` 型定義に 1 行。）

- [ ] **Step 3: マスキング維持を確認**

`safeMd`/`safeJson` は既存 `maskSecrets` を通っている（`report.ts:264-265`）。txSection もこの後段でマスクされる。追加のマスク不要。

- [ ] **Step 4: ビルド＋既存テスト**

Run: `pnpm --filter @crawl-kit/behavior build && pnpm --filter @crawl-kit/behavior test report`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/behavior/src/pipeline/report.ts packages/behavior/src/domain/types.ts
git commit -m "feat: add API transaction log section to report.md/json"
```

---

## Task 8: viewer — /transactions.jsonl エンドポイント

**Files:**
- Modify: `packages/viewer/src/server.ts`
- Test: `packages/viewer/src/server.test.ts`（無ければ Create）

**Interfaces:**
- Consumes: `DATA_FILES.behaviorTransactions`, `dataPath`（`@crawl-kit/contract`）。
- Produces: `GET /transactions.jsonl` が `data/behavior.transactions.jsonl` を `application/x-ndjson` で返す（無ければ空 200）。テスト用に純関数 `readTransactionsJsonl(): Promise<string>` を export。

- [ ] **Step 1: 失敗するテストを書く**

`packages/viewer/src/server.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readTransactionsJsonl } from './server.js'

describe('readTransactionsJsonl', () => {
  it('returns a string (empty when file absent)', async () => {
    const out = await readTransactionsJsonl()
    expect(typeof out).toBe('string')
  })
})
```

- [ ] **Step 2: テストが落ちるのを確認**

Run: `pnpm --filter @crawl-kit/viewer test`
Expected: FAIL（`readTransactionsJsonl` 未定義）。

- [ ] **Step 3: 実装を書く**

`packages/viewer/src/server.ts`:
先頭 import に追加:
```ts
import { DATA_FILES, dataPath } from "@crawl-kit/contract";
```
純関数を追加:
```ts
export async function readTransactionsJsonl(): Promise<string> {
  try {
    return await readFile(dataPath(DATA_FILES.behaviorTransactions), "utf8");
  } catch {
    return "";
  }
}
```
ルーティングに分岐を追加（`/diff.json` の分岐の後）:
```ts
    if (req.url === "/transactions.jsonl") {
      const body = await readTransactionsJsonl();
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      res.end(body);
      return;
    }
```

- [ ] **Step 4: テストが通るのを確認**

Run: `pnpm --filter @crawl-kit/viewer test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/viewer/src/server.ts packages/viewer/src/server.test.ts
git commit -m "feat: viewer serves /transactions.jsonl from data/"
```

---

## Task 9: viewer SPA — 「通信ログ (API)」タブ

**Files:**
- Modify: `packages/viewer/index.html`

**Interfaces:**
- Consumes: `GET /transactions.jsonl`（Task 8）。

**背景（既存構造）:** `VIEWS` 配列（`index.html:119` 付近）がタブ定義。`buildSections()` が `<section id="view-<key>">` を作り、`renderView(v)` が `v.key` で分岐。DOMContentLoaded で `DATA`/`DIFF` を fetch（`index.html:128-129`）。`.data-table` スタイルあり。

- [ ] **Step 1: VIEWS にタブを足す**

`VIEWS` 配列に追加（`diff` の後）:
```js
  {key:"transactions", label:"通信ログ (API)", icon:"🔌", diagram:null},
```

- [ ] **Step 2: transactions を動的読込**

DOMContentLoaded 内、`DIFF` の fetch の後に:
```js
  let TX = [];
  try {
    const txt = await (await fetch("/transactions.jsonl")).text();
    TX = txt.split("\n").filter(l=>l.trim()).map(l=>{ try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch(e){}
  window.__TX = TX;
```

- [ ] **Step 3: renderView に分岐を足す**

`renderView(v)` の分岐（`index.html:170-172` 付近）に追加:
```js
  else if(v.key==="transactions") h+=`<div class="view-desc">実行中に観測した同一オリジン API 通信（全件・動的読込）。method/path/status で絞り込み。</div>`+txView();
```
補助関数を追加（他の *Table 関数の近く）:
```js
function txView(){
  const rows=(window.__TX||[]).map(t=>{
    const cls = t.ok ? "" : ' style="background:#fde8e8"';
    return `<tr${cls}><td>${t.method}</td><td>${t.path}</td><td>${t.status??(t.failed?"FAILED":"-")}</td><td>${t.stage}</td><td>${t.ok?"✓":"⚠"}</td></tr>`;
  }).join("");
  if(!rows) return `<p class="empty">通信ログがありません（analyze/run 後に生成されます）。</p>`;
  const filter=`<input id="tx-filter" placeholder="method/path で絞り込み" style="margin-bottom:10px;padding:7px 10px;width:280px;border:1px solid var(--border);border-radius:6px">`;
  return filter+`<table class="data-table" id="tx-tbl"><thead><tr><th>method</th><th>path</th><th>status</th><th>stage</th><th>ok</th></tr></thead><tbody>${rows}</tbody></table>`;
}
```

- [ ] **Step 4: クライアント側フィルタを配線**

`#main` の入力イベントで tx-tbl を絞る。既存の click 委譲（`index.html:143`）の近くに追加:
```js
  document.getElementById("main").addEventListener("input", (e)=>{
    if(e.target.id!=="tx-filter") return;
    const q=e.target.value.toLowerCase();
    document.querySelectorAll("#tx-tbl tbody tr").forEach(tr=>{
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });
```

- [ ] **Step 5: 手動確認**

Run: `pnpm --filter @crawl-kit/viewer dev`（別途 `data/behavior.transactions.jsonl` があれば全件表示）。ブラウザで `http://localhost:4317` → サイドバー「通信ログ (API)」。
Expected: タブが出て、jsonl があれば表に全件、フィルタで絞れる。空でも空メッセージが出てクラッシュしない。

- [ ] **Step 6: Commit**

```bash
git add packages/viewer/index.html
git commit -m "feat: viewer transactions tab with dynamic jsonl full-list view"
```

---

## Task 10: boundary の method 対応ペアリング＋saved 受け皿の回帰テスト

**Files:**
- Modify: `packages/verification/src/boundary.test.ts`

**Interfaces:**
- Consumes: `assembleBoundaries(structureNodes, behaviorNodes)`, `verifyBoundaries`（既存 `boundary.ts`）。

**背景:** `boundary.ts` は既に `r.saved`（184）と `normalizeRoute` 経由の method 込み route を読む。ここでは「transaction 由来ノード（`POST /orders`）と structure の `POST /orders` route が同一境界にペアリングされる」ことと「`saved` があれば `roundtrip-ok`」を回帰テストで固定する（本 plan の producer 修正が受け皿を正しく満たすことの担保）。

- [ ] **Step 1: 回帰テストを追加**

`packages/verification/src/boundary.test.ts` に追記:
```ts
import { assembleBoundaries, verifyBoundaries } from './boundary.js'
import type { LayerNode } from '@crawl-kit/contract'

const sNode = (route: string, crud: string[]): LayerNode => ({
  nodeId: `structure:route/${route}`, layer: 'structure', localName: route, route,
  raw: { inputs: ['name'], events: [], crud, entity: 'Order' }, source: { tool: 'rdra' },
})
const bTx = (route: string, saved?: string[]): LayerNode => ({
  nodeId: `behavior:page/${route}`, layer: 'behavior', localName: route, route,
  raw: { inputItems: ['name'], ...(saved ? { saved } : {}) }, source: { tool: 'loop-e2e' },
})

describe('boundary method-aware pairing + saved', () => {
  it('pairs POST structure route with POST behavior node on the same boundary', () => {
    const bs = assembleBoundaries([sNode('POST /orders', ['C'])], [bTx('POST /orders')])
    expect(bs).toHaveLength(1)
    expect(bs[0].inStructure).toBe(true)
    expect(bs[0].inBehavior).toBe(true)
    expect(bs[0].persists).toBe(true)
  })
  it('reports roundtrip-ok when saved is present', () => {
    const rep = verifyBoundaries(assembleBoundaries([sNode('POST /orders', ['C'])], [bTx('POST /orders', ['name'])]), 't')
    expect(rep.findings.some((f) => f.kind === 'roundtrip-ok')).toBe(true)
  })
  it('reports persistence-unobserved when saved is absent (A+B expected state)', () => {
    const rep = verifyBoundaries(assembleBoundaries([sNode('POST /orders', ['C'])], [bTx('POST /orders')]), 't')
    expect(rep.findings.some((f) => f.kind === 'persistence-unobserved')).toBe(true)
  })
})
```
注: `assembleBoundaries` の behavior 分岐は `nodeId.startsWith("behavior:page/")` を見る（`boundary.ts:179`）。transaction ノードの nodeId は `behavior:tx/` なので、boundary に取り込ませるには nodeId 前置詞を合わせる必要がある。→ **Step 2 参照。**

- [ ] **Step 2: boundary が transaction ノードも取り込むよう修正**

`packages/verification/src/boundary.ts:179` の behavior 取り込み条件を、page と tx の両方を受けるよう変更:
```ts
  for (const n of behaviorNodes) {
    if (!(n.nodeId.startsWith("behavior:page/") || n.nodeId.startsWith("behavior:tx/"))) continue;
```
（テスト側 `bTx` の nodeId を実態に合わせ `behavior:tx/${route}` にしてもよい。どちらかで page/tx 双方が境界に入ることを担保する。上の Step 1 テストは `behavior:page/` を使っているので、この Step で tx 前置詞も許可すれば両系統が通る。）

- [ ] **Step 3: テストが通るのを確認**

Run: `pnpm --filter @crawl-kit/verification test boundary`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add packages/verification/src/boundary.ts packages/verification/src/boundary.test.ts
git commit -m "feat: boundary ingests method-aware tx nodes; regress saved receptacle"
```

---

## Task 11: DB 接続設定サンプル ＋ ドキュメント

**Files:**
- Modify: `e2e.config.yaml`（リポジトリ内のサンプルがあれば。無ければ `docs/OPERATIONS.md` にサンプルとして記載）
- Modify: `docs/OPERATIONS.md`

**Interfaces:** なし（設定・文書のみ）。既存 `DbSchema`（`config/schema.ts:27-35`）に沿う。

- [ ] **Step 1: サンプルを書く**

`docs/OPERATIONS.md` に節を追加:
```markdown
## DB 接続を足す（永続化観測を有効化）

`e2e.config.yaml` に `databases:` を追加すると、CREATE/UPDATE の永続化観測が有効になる
（パスワードは環境変数から）。

​```yaml
databases:
  - name: app
    type: postgres        # or mysql
    host: localhost
    port: 5432
    database: myapp
    user: myapp
    passwordEnv: DB_PASSWORD
​```

- `passwordEnv` は環境変数名。値そのものは書かない（`export DB_PASSWORD=...`）。
- 複数接続は配列で並べる。scenario の `expectedDbState.connection` は `name` と一致させる。
```
（リポジトリ直下に実 `e2e.config.yaml` サンプルがあるなら、同じ `databases:` ブロックをコメント付きで追記。）

- [ ] **Step 2: Commit**

```bash
git add docs/OPERATIONS.md e2e.config.yaml
git commit -m "docs: how to add DB connection for persistence observation"
```

---

## Task 12: 全体ビルド＋テストのグリーン確認

**Files:** なし（検証のみ）。

- [ ] **Step 1: 全パッケージビルド**

Run: `pnpm -r build`
Expected: 全パッケージ成功。

- [ ] **Step 2: 全テスト**

Run: `pnpm -r test`
Expected: recorder / emit / txSummary / viewer / boundary の新規テスト含め全て PASS。

- [ ] **Step 3: デモで煙テスト（任意・DB/アプリ不要な範囲）**

Run: `pnpm demo && pnpm --filter @crawl-kit/viewer dev`
Expected: 既存デモが通り、viewer に「通信ログ (API)」タブが出る（サンプルに transactions が無ければ空メッセージ）。

- [ ] **Step 4: Commit（必要なら lockfile/生成物）**

```bash
git add -A
git commit -m "chore: A+B green — build and tests pass"
```

---

## Self-Review

**Spec coverage:**
- A-1 DB 設定サンプル → Task 11 ✓
- A-2 配線（method 対応 emit ＋ boundary 受け皿）→ Task 4, 5, 10 ✓（`saved` 実充填は C/D、plan 冒頭 Global Constraints に明記）
- B-1/B-2 レコーダ＋jsonl → Task 1, 2, 3 ✓
- B-3 レポート要約 → Task 6, 7 ✓
- B-4 viewer 橋渡し＋エンドポイント＋タブ → Task 1(DATA_FILES), 5(bridge), 8(endpoint), 9(SPA) ✓
- テスト（recorder/txSummary/viewer/emit/boundary）→ Task 2,6,8,4,10 ✓；reconciler の method 対応は `normalizeRoute` 既存のため boundary 回帰(Task 10)で担保 ✓

**Placeholder scan:** TBD/TODO 無し。各コード step に実コードを記載。

**Type consistency:**
- `ApiTransaction`/`RecordStage`/`DEFAULT_BODY_CAP_BYTES`/`TRANSACTIONS_SUFFIX`（Task 1）を Task 2/5/6/7 で一貫使用。
- `createRecorder(opts).attach(page, stage)` / `.path` を Task 2 定義・Task 3 消費。
- `emitTransactionNodes` / `emitBehaviorAll(…, txs)`（Task 4）を Task 5 消費。
- `renderTransactionSection(txs, jsonlRef)` / `summarizeTransactions`（Task 6）を Task 7 消費。
- `DATA_FILES.behaviorTransactions`（Task 1）を Task 5/8 消費。
- `readTransactionsJsonl()`（Task 8）を Task 8 テスト・server で使用。

**判明済みリスク/前置き:**
- Task 3 の runId 取得スコープは実コードに合わせて調整（run 本体は `ctx.runId`、explore コマンドは無ければ生成）。
- Task 10 は boundary が `behavior:tx/` を取り込むよう 1 行広げる（producer 修正の受け皿確定）。
