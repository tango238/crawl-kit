# 設計: behavior の CRUD/API 観測基盤（spec A+B）

- 日付: 2026-07-01
- 対象リポジトリ: `crawl-kit`（pnpm workspace, TypeScript）
- 状態: 承認済み（brainstorming 完了、実装計画は別途 writing-plans で作成）

## 背景

crawl-kit の behavior 層は現状「ナビゲーション観測 ＋ 入力バリデーション探索（reject 中心）」が主眼で、
CRUD ライフサイクル（作成／更新／削除）という概念を持たない。調査（並列スキャン＋敵対的精査）で以下を確定した。

- **explore** は汎用フォーム submit を 1 つ叩くだけで、create/update/delete を区別しない。DELETE を起こす UI も発行も無い。
- **DB 確認**は存在チェックのみ（`dbProbe.wasValueSaved`: `SELECT 1 ... WHERE col=値`, `rows>0`）。absence 判定は無い。
- **registeredData** は「行が在り値が一致」しか言えず、行不在は常に失敗扱い。`ExpectedDbStateSchema` に削除表現なし。
- **verification/boundary.ts** は `b.persists = crud.includes("C") || crud.includes("U")` で "D" を明示除外。
- **emit.ts** は `routeKey` を `GET` 固定で HTTP メソッドを捨てる。
- **配線バグ**: `emit.ts` が `saved` を出力しないため、`boundary.ts` の `b.saved` は常に `null` → 永続化チェック（README がうたう "killer check"）が現状の配線では死んでいる。
- 一方 **structure** 層は "D" を含め CRUD を完全モデル化済み（`crud.ts`, `to-extract.ts`, `model.ts`）。DB 接続設定（`DbSchema`）も既に完備。

CREATE=部分的／UPDATE=弱い／DELETE=皆無、という状態。本 spec はこの土台を整える。

## スコープ

本 spec（A+B）は「今起きている API 通信を漏れなく観測・記録し、既存の永続化チェックの配線を復活させる」ところまで。
CRUD 成功パスを**能動的に叩く executor** と、その入力を導出する**事前解析**は次の spec（C/D）に送る。

### やること

- **A-1 DB 接続設定サンプル**: `e2e.config.yaml` の `databases:` 記述例を追加（スキーマは既存、追記のみ）。
- **A-2 配線バグ修正**: `emit.ts` が実 HTTP メソッドと `saved` を behavior ノードに載せ、`boundary.ts` がそれを読む。
- **B-1 API 通信レコーダ**: 全ページに Playwright イベントリスナを付け、同一オリジンの API req/res を捕捉。
- **B-2 保存**: `.e2e/runs/<runId>/transactions.jsonl`（フル記録＋サイズキャップ＋マスキング）。
- **B-3 レポート統合**: `report.md` に「API 通信ログ」要約表を追加（決定的生成）。
- **B-4 viewer 統合**: `data/` に橋渡し → viewer が jsonl を動的読み込みして全件表示。

### やらないこと（次の spec = C/D）

- CRUD 成功パスの能動実行（作成/更新/削除を意図的に叩く executor）。
- 入力値を DB 定義＋ソースから導出する事前解析アーティファクト。
- DELETE の実行・absence 判定、UPDATE の旧→新差分。
- `boundary.ts` の "D" 対応（本 spec では `C||U` 据え置き）。

B は「観測のみ」。C/D が乗る土台になる。

## アーキテクチャ / データフロー

```
crawl/explore/scenario/login の各 page
   │  page.on(request/response/requestfinished/requestfailed)
   ▼
Recorder（同一オリジン API のみ・マスク・キャップ）
   │  append
   ▼
.e2e/runs/<runId>/transactions.jsonl ──► report.md「API 通信ログ」要約表
   │  emit/analyze で転記
   ▼
data/behavior.transactions.jsonl ──► viewer /transactions.jsonl ──► SPA 動的全件表示
```

**設計原則**: viewer は「`data/` だけ読む dumb renderer」（`view-model.ts` に明記）。`.e2e/` を直接読ませず、
emit 段で `data/` に転記して viewer に渡す。役割分担は 3 層 — report.md=要約（人が最初に見る）／viewer=全件ブラウザ（動的読込で深掘り）／jsonl=生の真実。

## コンポーネント

### B-1/B-2 レコーダ（`packages/behavior/src/services/browser/recorder.ts`）

トランザクション record（jsonl 1 行 = 1 トランザクション）:

```ts
type ApiTransaction = {
  runId: string
  seq: number              // run 内の発生順
  ts: string               // ISO8601（リクエスト開始）
  durationMs: number
  stage: 'crawl' | 'explore' | 'scenario' | 'login'
  method: string           // GET/POST/PUT/PATCH/DELETE
  url: string              // フル URL（マスク済）
  path: string             // pathname（routeKey の基）
  resourceType: string     // 'xhr' | 'fetch' | 'document'
  requestQuery?: Record<string, string>
  requestBody?: string     // マスク+truncate 済
  requestBodyTruncated?: boolean
  status?: number
  statusText?: string
  responseBody?: string    // マスク+truncate 済
  responseBodyTruncated?: boolean
  ok: boolean              // status 2xx-3xx
  failed?: boolean         // 応答なし失敗（requestfailed）
  errorText?: string
}
```

捕捉ルール（フィルタ）:

- 同一オリジン（`url` が `target.baseUrl` のオリジンで始まる）**かつ**
- `resourceType ∈ {xhr, fetch, document}`（API 呼び出し＋ドキュメント遷移。js/css/画像/font 等の静的アセットは除外）。
- 主対象は xhr/fetch。document（ページ GET 遷移）も同一オリジンなら文脈として安価に残す。設定で document 除外可。

API:

```ts
createRecorder(runId, root, { baseUrl, secrets, bodyCapBytes }) => {
  attach(page, stage)   // page.on(...) を仕掛ける
  // 各イベントで record 構築 → maskSecrets → truncate → appendFile(jsonl)
}
```

- `appendActivity` と同じ**追記ストリーム方式**（メモリに溜めない）。
- レスポンスボディは `requestfinished` 後に `response.text()`、失敗は `requestfailed`。読めない応答（リダイレクト等）は try/catch で本文なし記録。

マスキング／キャップ:

- 既存 `maskSecrets(text, allSecrets)` を url / requestBody / responseBody に適用。`allSecrets` は report.ts と同じ集合
  （anthropic / github / db passwords / targetAuth）。
- `bodyCapBytes` 既定 **32KB**（config で変更可）。超過は truncate ＋ `*Truncated: true`。

配線（全ページに付ける）:

- 現状 `createPage`（`cli/index.ts`）や explore の `exCreatePage` に個別に付けている response リスナを **Recorder.attach に一本化**。
  crawl（`crawler.ts`）・login も page 生成経路に attach を通す。

### B-3 レポート統合（`packages/behavior/src/pipeline/txSummary.ts` ＋ `report.ts`）

- `txSummary.ts`: 対象 run の `transactions.jsonl` を読み、要約を組み立てる。
- `report.md` に「## API 通信ログ」セクションを追加（既存 `activitySection` と同じ挿入方式）:
  - 総件数、method 別内訳（GET/POST/PUT/PATCH/DELETE 件数）。
  - **失敗（非 2xx / requestfailed）をハイライトした表**: `method | path | status | stage`。
  - 生ログへのリンク: `.e2e/runs/<runId>/transactions.jsonl`。
- `report.json` に `transactionsRef`（jsonl パス）＋集計値を格納。
- **決定的生成**（LLM を通さない＝秘匿情報がプロンプトに乗らない）。

### B-4 viewer 統合（`packages/viewer/src/server.ts` ＋ SPA）

- **橋渡し**: behavior の emit（または analyze）段で、最新 run の `transactions.jsonl` を `data/behavior.transactions.jsonl` に転記。
- **エンドポイント**: `server.ts` に `/transactions.jsonl` を追加（`data/behavior.transactions.jsonl` をストリーム配信）。
  既存の `/view-model.json` `/diff.json` と同列。
- **SPA**: viewer に「通信ログ (API)」タブ／セクションを追加。表示時に `/transactions.jsonl` を **fetch で動的読み込みし全件表示**
  （クライアント側で method/status/path のフィルタ・検索）。件数が多くても report.md は膨らまず、viewer 側で全件を追える。

### A-1 DB 接続設定サンプル

`e2e.config.yaml` に記述例を追加（スキーマは既存 `DbSchema`、追記のみ）:

```yaml
databases:
  - name: app
    type: postgres        # or mysql
    host: localhost
    port: 5432
    database: myapp
    user: myapp
    passwordEnv: DB_PASSWORD   # 値は環境変数から（秘匿）
```

`docs/OPERATIONS.md` に「DB 接続の足し方」と、これで CREATE/UPDATE の永続化観測が有効化される旨を記載。

### A-2 配線バグ修正（`emit.ts` ＋ `boundary.ts`）

- `emit.ts`: `routeKey` の `GET` ハードコードを廃し、**API 通信の実メソッド**で route key を生成（`POST /orders` 等）。
  behavior ノードの `raw` に `method` と、永続化観測がある場合 `saved` を載せる。
- `boundary.ts`: 既に `r.saved` を読む実装なので producer 側修正で永続化チェックが機能。
  `b.persists = C||U`（"D" 除外）は**本 spec では据え置き**（DELETE 観測は C/D spec）。
- **正直なスコープ（配管のみ）**: コードを追った結果、explore の `wasValueSaved` プローブ結果は**どこにも永続化されておらず**
  （`explore.ts:152-160`、`classifyGap` に渡して捨てる）、emit まで届く既存の `saved` 供給源は**存在しない**。
  さらに HTTP 2xx ≠ DB 保存なので transactions からも `saved`（DB のどの列が残ったか）は出せない。
  よって A+B の A-2 は:
  - **やる**: emit が transactions から **method 対応の behavior ノード**を出す（`routeKey` GET 固定バグの解消）＋
    `boundary.ts` が `saved`/`method` を読める**受け皿（配管）を通す**。
  - **やらない（C/D 送り）**: `saved` の実充填（能動 executor＋DB プローブが要る）。A+B では `saved` 未供給なので
    boundary は正しく `persistence-unobserved`（未観測）と出る＝黙って死なない。
  method 対応 route key と永続化配管が C/D の happy-path 実行の土台になる。
- **リップル**: route key が method 付きになると reconciler の route マッチングが method を見るようになる。
  structure 側は既に HTTP→CRUD を持つ（`crud.ts`）ので整合方向。マッチングの回帰テストを追加。

## エラー処理

- Recorder は**ベストエフォート**: リスナ内例外・本文読取失敗は握って warn どまり、クロール本体を絶対に止めない
  （既存 explore の response リスナと同じ方針）。
- jsonl 追記失敗も warn どまり（レポート生成やクロールを落とさない）。

## テスト

- **recorder**: 疑似 page が request/response を発火 → jsonl 行・フィルタ（アセット除外・クロスオリジン除外）・truncate・マスクを検証。
- **txSummary**: トランザクション群 → 要約表・失敗ハイライトを検証。
- **viewer server**: `/transactions.jsonl` 配信を検証。
- **emit**: routeKey が実メソッドになる／`saved`・`method` が raw に載る。
- **boundary**: `saved` があるとき `roundtrip-ok`／`not-persisted` が正しく出る。
- **reconciler**: method 付き route key のマッチング回帰。

## 次の spec（C/D）へ渡すもの

- 本 spec で整った観測基盤（transactions.jsonl ＋ 永続化配線 ＋ 実メソッド route key）の上に、
  CRUD 成功パスの能動実行（C: 入力導出の事前解析、D: 実行＆成功オラクル、DELETE の absence 判定）を乗せる。
