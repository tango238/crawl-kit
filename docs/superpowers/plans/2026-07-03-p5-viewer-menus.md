# P5: viewer 4メニュー + ダッシュボード Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** viewer を「ダッシュボード + intent(3) + structure(5) + behavior(2) + 観測マップ(3)」の4メニュー14ビュー構成に再編する。ダッシュボードは progress.json と成果物の有無から「何が未実行だからどのメニューが空か」を説明する。

**Architecture:** サーバ側 view-model 組立（viewer パッケージの純関数）+ ビルド不要の素の ES modules フロント（`packages/viewer/public/`、hash ルーティング、1ビュー1ファイル）。CLI へは esbuild bundle ではなく **静的ディレクトリ同梱**（cli build 時に `packages/viewer/public` → `packages/cli/dist/viewer-public` へコピーし、serve が fs から配信）。既存の `/view-model.json`・`/diff.json` は維持し、新規 API を追加。既存 `packages/viewer/index.html`（410行、観測マップ/diff/transactions を描画）は各ビューへ**移植**して最後に削除。

**Tech Stack:** TypeScript（サーバ側）+ 素の JS ES modules（フロント、ビルドなし・依存なし。Mermaid は既存 index.html と同じ読み込み方式を踏襲）

**親スペック:** `docs/superpowers/specs/2026-07-03-workspace-unified-pipeline-design.md` G 節（E 節の通信ログ要件含む）

## Global Constraints

- ESM / `.js` import。viewer パッケージはファイルの既存スタイルに従う。cli はセミコロンあり
- サーバ側モデルビルダーは純粋・無音（console 禁止）。フロント JS も console.log を残さない
- 既存エンドポイント `/view-model.json` `/diff.json` の応答形は変えない（追加のみ）
- **通信ログの絞り込み**（スペック E）: アクセス URL 軸は structure のルーティングと `normalizeRoute`（contract）で一致するもののみ表示
- ダッシュボードの説明責務（スペック G）: フェーズ status/タスクバー + blockedReason + 「このメニューが空なのは○○未実行のため（実行コマンド案内）」
- TDD: サーバ側ビルダー/エンドポイントはユニットテスト必須。フロントは「配信されるか + HTML/JS に期待マーカーが含まれるか」の構造テスト + Task 7 の実 CLI スモークで検証
- 各タスク: viewer/cli スイート全緑 + lint 後にコミット

---

### Task 1: viewer — サーバ側モデルビルダー（dashboard / intent / traffic / sitemap）

**Files:**
- Create: `packages/viewer/src/dashboard-model.ts`, `packages/viewer/src/intent-model.ts`, `packages/viewer/src/traffic-model.ts`
- Modify: `packages/viewer/src/index.ts`（export 追加）
- Test: 各 `.test.ts`（temp workspace fixture。view-model.test.ts の流儀を踏襲）

**Interfaces:**
- `buildDashboardModel(): Promise<DashboardModel>`:
  - progress: `readProgressOrEmpty(progressPath(resolveRoot()), "viewer")` の中身（フェーズ status / tasks / blockedReason）
  - artifacts: 主要成果物の有無 `{ intentNodes, intentAggregates, structureRdra, unified, behaviorNodes, transactions, sitemap, mapping }: boolean`
  - guidance: `Array<{ menu: string; ok: boolean; reason?: string; command?: string }>` — メニュー→必要成果物のマッピング:
    - intent 系 → intent.nodes.json（無 → 「intent フェーズ未実行」+ blockedReason があれば併記 + `crawl-kit run --only intent`）
    - structure 系 → structure.rdra.json / unified.json（→ `crawl-kit run --only structure`）
    - behavior 通信ログ → behavior.transactions.jsonl + structure routes、画面遷移 → behavior.sitemap.json（→ `crawl-kit run --only behavior`。blocked なら blockedReason を表示）
    - 観測マップ → unified.json + 各層 nodes
- `buildIntentModel(): Promise<IntentModel>`: intent.nodes.json + intent.aggregates.json + mapping.aggregate-entity.json から `{ events: [{name, aggregate, trigger, properties, consumer}], aggregates: [{name, conceptId, members, entities(mappingから) }], transitions: [{aggregate, from, to, trigger, event}] }`。ファイル欠落は空配列
- `buildTrafficModel(): Promise<TrafficModel>`: 
  - structure routes（unified.json or structure.nodes.json の `structure:route/`）を軸に、`data/behavior.transactions.jsonl` を行パースし `normalizeRoute("<METHOD> <path>")` 一致でグループ化。**一致しない tx は含めない**
  - 各グループ: `{ route, method, txs: [{ seq, ts, stage, status, ok, requestQuery?, requestBody?, responseBody?(32KB上限は記録側で済), persisted? }] }` — persisted は behavior.nodes.json の `behavior:tx/` ノードから route キーで引く
  - pages: behavior.edges.json から `{ url, elements: [{kind, label?, to}] }`（そのページに表示されたアクションエレメント=出エッジ、kind=click は「押した」もの）— structure routes と一致する URL のみ
- `readSitemapModel(): Promise<Sitemap | null>`: data/behavior.sitemap.json をそのまま（無ければ null）
- すべて `dataPath`/`DATA_FILES`/`resolveRoot`（contract）経由。純関数部（join/グループ化）は I/O から分離してテスト

- [ ] TDD → コミット `feat(viewer): dashboard/intent/traffic/sitemap server-side models`

---

### Task 2: viewer+cli — API ルートマップと静的アセット配信

**Files:**
- Create: `packages/viewer/src/api.ts`（`apiRoutes: Record<string, () => Promise<unknown>>` — `"/api/dashboard.json"`, `"/api/intent.json"`, `"/api/traffic.json"`, `"/api/sitemap.json"`, 既存 `"/view-model.json"`, `"/diff.json"`, `"/transactions.jsonl"`(生パススルー、viewer/src/server.ts の実装を移す)）
- Modify: `packages/cli/src/commands/serve.ts`（`startViewer` の opts に `assetsDir?: string` を追加。指定時: `/` と静的ファイル（.html/.js/.css/.svg の content-type 付き、パストラバーサル防止 `normalize` + prefix チェック）を assetsDir から配信し、`apiRoutes` を全部結線。`html` パラメータは assetsDir 未指定時のフォールバックとして維持）
- Modify: `packages/cli/src/index.ts`（cmdServe/cmdRunWorkspace 呼び出し: assetsDir 解決 — bundled: `join(here, "viewer-public")`、repo dev: `join(here, "../../viewer/public")` の存在する方。`VIEWER_HTML` import は Task 7 で削除するため本タスクでは残す）
- Modify: `packages/cli/package.json`（build script 末尾に `&& cp -R ../viewer/public dist/viewer-public`）
- Modify: `packages/viewer/src/server.ts`（開発サーバも apiRoutes + public/ を配信 — cli と挙動一致）
- Test: serve.test.ts 追記（temp assetsDir から index.html/JS 配信、`/api/dashboard.json` が JSON を返す、`../` パスが 403/404）

**注意:** `packages/viewer/public/` は Task 3 で作るため、本タスクのテストは temp dir に fixture アセットを置いて行う。

- [ ] TDD → コミット `feat(viewer): api route map + static asset serving in startViewer`

---

### Task 3: フロント — シェル + ルーター + ダッシュボード

**Files:**
- Create: `packages/viewer/public/index.html`（シェル: サイドバー4メニュー+ダッシュボード、`<main id="view">`、`<script type="module" src="/app.js">`）
- Create: `packages/viewer/public/app.js`（hash ルーター: `#/` → dashboard、`#/intent/{events,aggregates,transitions}`、`#/structure/{routes,usecases,entities,er,uc-entity}`、`#/behavior/{traffic,sitemap}`、`#/map/{events,transitions,boundary}`。ルート→`views/<name>.js` の dynamic import、fetch ヘルパー（失敗時はビュー内にエラーメッセージ）、nav の active 表示）
- Create: `packages/viewer/public/style.css`（既存 index.html のスタイルをベースに移植）
- Create: `packages/viewer/public/views/dashboard.js`（/api/dashboard.json → フェーズごとの status バッジ + tasks 進捗バー(completed/total) + updatedAt + guidance リスト（ok でないメニューは理由と実行コマンドを表示））
- Test: serve.test 追記（実 public/ を assetsDir にして `/` に `id="view"` とメニューのラベル（ダッシュボード/intent/structure/behavior/観測マップ）が含まれる、`/app.js` と `/views/dashboard.js` が JS で配信される）

- [ ] 実装（フロントは構造テストのみ）→ コミット `feat(viewer): SPA shell + hash router + dashboard view`

---

### Task 4: フロント — intent 3ビュー + structure 5ビュー

**Files:**
- Create: `packages/viewer/public/views/intent-events.js`, `intent-aggregates.js`, `intent-transitions.js`（/api/intent.json。events はテーブル、aggregates は members+entities（mapping由来、confidence/evidence 表示）、transitions は集約ごとの from→to 一覧（集約×イベントが分かるよう event 列を含む））
- Create: `packages/viewer/public/views/structure-routes.js`, `structure-usecases.js`, `structure-entities.js`, `structure-er.js`, `structure-uc-entity.js`（/view-model.json 既存フィールドを描画。ER 図/UC 図は mermaid_sources を既存 index.html と同じ方式でレンダリング — 既存 410 行の該当描画コードを**移植**する。uc-entity は既存 `uc_entity_crud` の CRUD マトリクス）
- Test: serve.test 追記（各 views/*.js が配信される）+ 移植時に参照した既存機能の消失がないこと（Task 7 で旧 index.html 削除前に照合）

- [ ] 実装 → コミット `feat(viewer): intent + structure views`

---

### Task 5: フロント — behavior 2ビュー（通信ログ / 画面遷移）

**Files:**
- Create: `packages/viewer/public/views/behavior-traffic.js`（/api/traffic.json: URL(route) 軸のテーブル → 行クリックで展開: そのページの表示エレメント（リンク/ボタン、押したものは kind=click で強調）、tx 一覧（method/status/persisted バッジ(yes=緑/no=赤/unknown=灰)/query/body/response の折りたたみ表示））
- Create: `packages/viewer/public/views/behavior-sitemap.js`（/api/sitemap.json: ツリーを `<details>` ネストで描画、via.kind(link/click) と label を辺に表示、orphans は別リスト）
- Test: serve.test 追記（配信確認）

- [ ] 実装 → コミット `feat(viewer): behavior traffic + sitemap views`

---

### Task 6: フロント — 観測マップ 3ビュー（イベント / 状態遷移 / システム境界）

**Files:**
- Create: `packages/viewer/public/views/map-events.js`, `map-transitions.js`, `map-boundary.js`（/diff.json を分割描画。既存 index.html の side-by-side（intent/structure/behavior 3列、green=aligned/yellow=gap）と System Boundary（route input→display→persist）描画コードを**移植**して 3 ビューへ分離。behavior 列は観測結果からの逆算である旨の注記を維持）
- Test: serve.test 追記（配信確認）

- [ ] 実装 → コミット `feat(viewer): observation map views (events/transitions/boundary)`

---

### Task 7: 旧 index.html 削除 + 全体検証 + スモーク + README

**Files:**
- Delete: `packages/viewer/index.html`（全ビュー移植済み確認後）
- Modify: `packages/cli/src/index.ts`（`VIEWER_HTML` text import と esbuild `--loader:.html=text` の削除、`startViewer` は assetsDir のみに。`html` フォールバックも不要なら整理 — serve.ts の `html` オプションを optional にし assetsDir 優先）
- Modify: `README.md`（4メニュー構成・各ビューの説明・ダッシュボードのガイダンス仕様）

**検証:**
- [ ] `pnpm -r lint && pnpm -r test && pnpm --filter @tanago3/crawl-kit build`（cp が dist/viewer-public を作ること）
- [ ] スモーク: fixture workspace（P3 スモークの intent.json + demo 相当のデータを `crawl-kit demo` か手置きで用意）で `node dist/index.js serve --port 0` 相当を起動し、curl で: `/`（シェル HTML）、`/app.js`、`/api/dashboard.json`（guidance に空メニューの理由が入る）、`/api/intent.json`、`/api/traffic.json`、`/api/sitemap.json`、`/view-model.json`、`/diff.json` すべて 200。データ空でも 500 にならないこと（欠落成果物は空モデル）
- [ ] `crawl-kit run --no-viewer` 後の再 serve でダッシュボードの progress が反映されることを確認（demo ベース）
- [ ] コミット `feat(viewer): remove legacy single-page html; docs`

---

## Self-Review 結果

- **スペック G 節網羅**: ダッシュボード（進捗バー+ガイダンス）→ T1/T3。intent 3 → T1/T4。structure 5 → T4（既存 view-model 再利用）。behavior 通信ログ（E 節の URL 軸・structure 一致絞り込み・エレメント・persisted）→ T1(traffic-model)/T5。画面遷移 → T1/T5。観測マップ 3 → T6（既存 diff.json 移植）。viewer 自動起動は P2 済み（assetsDir 化を T2/T7 で反映）。
- **型整合**: DashboardModel/IntentModel/TrafficModel（T1）↔ apiRoutes（T2）↔ 各ビュー fetch 先（T3-6）。normalizeRoute は P4 で contract へ移動済み（viewer は contract 依存のみで join 可能 — P4 最終レビューの決定事項）。
- **順序**: T1 → T2 → T3 → T4/T5/T6（相互独立だが同一パッケージのため直列）→ T7。
- **リスク**: フロントは自動テストが構造レベルに留まる — T7 スモークで全エンドポイント+アセットを実 CLI 検証し、視覚確認は最終的にユーザーへ委ねる（playwright はサンドボックスに無い）。

## 積み残し（バックログ）

P5 全体レビュー（whole-branch review）で識別された、本ブランチのスコープ外として先送りした項目:

- **crud の behavior フェーズ自動実行** — 現状 persisted yes/no は `loop-e2e crud`（能動 CRUD 検証）の手動実行が前提。`crawl-kit run` は crud を自動実行しないため、`run` 単体では `persisted` は `unknown` のまま。crud の behavior フェーズへの組み込みは将来課題。
- **persisted はルート単位集約** — spec F の「per-transaction 印」はデータモデル拡張が必要（現状は tx ノード単位ではなくルート単位で `extractTxPersistence` が集約している）。
- **sitemap の遷移×トランザクション紐付け** — spec F で注記済み・未実装。画面遷移ツリー（`behavior.sitemap.json`）と通信ログ（`behavior.transactions.jsonl`）は現状別ビューのまま、相互参照は無い。
- **NavEdge の redirect 対応** — enqueue 時 URL 記録の限界により、リダイレクトを挟む遷移がエッジとして正確に表現できない場合がある。
- **runBehavior の `--target` 非対応** — マルチターゲット（複数リポジトリ／複数オリジン）の behavior フェーズは未対応。
- **旧 viewer の全文検索・詳細サイドパネル・ソート・生 transactions 一覧ビューの再導入判断** — `/transactions.jsonl` API 自体は存続しているが、新 SPA からは消費されていない。再導入するかどうかは未決定。
- **map-shared.js の norm() ミラー** — `packages/viewer/public/views/map-shared.js` の `norm()`（イベント名をサーバの `/diff.json` の `eventRoutes` に再結合するためのクライアント側ミラー）は、diff-view 側で事前 join 化すれば解消できる（P5 Task 2 の traffic-model 同様、サーバ側 join 化でクライアントの正規化ロジックを削減する余地がある）。
