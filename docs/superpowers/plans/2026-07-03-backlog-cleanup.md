# バックログ一括対応 — 設計 + 実装計画（P4/P5 積み残し）

- 日付: 2026-07-03
- ブランチ: `feat/backlog-cleanup`
- 対象: P4/P5 レビューで先送りされた積み残しのうち、実装可能な5件
- スコープ外（ユーザー決定）: #5 `runBehavior --target` マルチターゲット（別 spec 相当）、#6 旧 viewer 機能再導入

各タスクは TDD（RED→GREEN→lint→commit）。`- [ ]` はエージェント実行用トラッキング。

---

## 全体像

| # | 項目 | 主な変更パッケージ | リスク |
|---|---|---|---|
| 7 | map-events の `norm()` をサーバ側 join 化 | viewer | 低（局所） |
| 4 | NavEdge の redirect 対応 | behavior | 低（局所） |
| 1 | crud を behavior フェーズで自動実行（ゲート付き） | cli | 中（破壊的・要ゲート） |
| 3 | tx にページ文脈を刻み sitemap×traffic を相互参照 | behavior + viewer | 中 |
| 2 | persisted を per-transaction ノード化 | behavior + contract + viewer | 中 |

実装順は依存と安全性で **#7 → #4 → #1 → #3 → #2**。#7/#4 は独立・低リスクで足場固め、#1 は既存設計流用、#3 と #2 は emit/recorder を触るため後段。

---

## #7: map-events の `norm()` をサーバ側 join 化

**問題**: `packages/viewer/public/views/map-shared.js` の `norm()`（`:12-19`）は、`/diff.json` の `events[]` を `eventRoutes[]` に再結合するためだけのクライアント側ミラー。サーバ（`diff-view.ts:186`）と同じ正規化を二重実装している。利用者は `map-events.js` 1つのみ。

**方針**: `traffic-model.ts` の `joinTrafficRoutes`（サーバが join キーを計算してモデルに載せる）パターンを踏襲。
- `diff-view.ts` の event 用 `DiffRow`（`:81-89`）に `routes?: EventRouteRow[]` を追加。event `DiffRow` 構築ループ（`:225-238`）で、既に手元にある `norm(e.name)` キーで `eventRoutes`（`:291-311`）を group して各行に付与。
- `map-events.js`: `norm`/`groupEventRoutes`（`:20,24-32,52`）を削除し `row.routes` を直読み。
- `map-shared.js` の `norm()` は唯一の利用者が消えるので削除（dead code）。
- `eventRoutes` トップレベル配列は他消費者のため残置（判断: 消さない）。

**テスト**: `diff-view` のユニットテストに「event 行へ routes が join される」ケース追加。viewer serve テストで map-events.js が配信され続けることを確認。

- [ ] TDD → コミット `refactor(viewer): server-side event→route join; drop client norm() mirror`

---

## #4: NavEdge の redirect 対応

**問題**: link エッジは enqueue 時に `to = normalizeUrl(href)` を記録する（`discover.ts:81-90`）が、実訪問後の `finalUrl`（`capture()` の `page.url()`、`:206`）はリダイレクト後URL。両者が食い違い、リダイレクト先が sitemap で orphan になり、phantom ノードが残る。click エッジは訪問後 `page.url()` を使うので正しい（`:186,198`）。root cause は `discover.ts:36-39` に DEFERRED として明記済み。

**方針**: link エッジの発火を enqueue 時から**訪問後**に移す。
- queue アイテムに意図した `from`/`href`/`kind`/`label` を載せて push（`:88`）、`:89` の即時 `onEdge` を除去。
- dequeue → `capture()` が `raw.url`（finalUrl）を解決した後（`:77` 付近）に `onEdge({ from, to: normalizeUrl(raw.url), kind: 'link', label })` を発火。click エッジの後発火（`:186,198`）と同型。
- これで `structure.pages`（`normalizeUrl` 済）とエッジ target が一致し、false orphan が解消。

**テスト**: `discover` のユニットテストで「href とは異なる finalUrl を返す fake page → エッジ target が finalUrl になる」ケース追加。既存の link/click エッジテストが緑のまま。

- [ ] TDD → コミット `fix(behavior): record nav edge target from post-redirect finalUrl`

---

## #1: crud を behavior フェーズで自動実行（DB+reseed ゲート付き）

**問題**: `crawl-kit run` は crud を実行しないため `*.crud-results.json` が無く、emit の tx `persisted` が常に未設定（＝ viewer で unknown 相当）。

**方針**: `packages/cli/src/index.ts` の `runBehaviorForWorkspace`（`:380-408`）で `loop-e2e run` と `loop-e2e emit` の間（`:390-395`）に**ゲート付きで** `loop-e2e crud` を挿入。emit は最新 `*.crud-results.json` を読むので（`emit.ts:81-99`）、crud が emit 前に artifact を書けば `persisted` は自動充填。emit.ts / tx-persistence.ts の変更は不要。

**ゲート条件**（`runCrud` の前提条件を先取り）:
```
config.databases.length > 0
  && Boolean(config.launch?.seed)                 // reseed 経路（未設定なら runCrud は abort）
  && 選択 target の auth?.strategy !== 'none'
```
満たさなければ crud だけスキップ（crawl+emit は継続、`persisted` は未設定のまま）。ゲート判定は `ctx.config` を持つ `behaviorPhase`（`run-phases.ts:166-176`）で行い、フラグを `runBehavior` に渡す。スキップ時は進捗台帳に理由を残す（`persisted は crud 未実行のため未取得` 等の note）。

**stale artifact 対策**: `loadLatestCrudResults` は全 run 横断で mtime 最新を拾う（`emit.ts:81-99`）。crud をスキップした run で古い crud-results を誤って拾わないよう、behavior フェーズ開始時に当該 run の crud-results スコープを明確化（run 単位 runId 前置は既存。emit が「今回の run の」結果だけ見るよう、crud 実行時のみ結果を残す運用とし、スキップ時に古いファイルを拾わない実装ガードをテストで固定）。

**テスト**: `run` のユニットテストで (a) DB+reseed+auth 揃い → crud spawn が呼ばれる、(b) DB 無し → crud skip・crawl/emit は継続・台帳に理由、の2ケース。`spawnNodeAsync` はモック。

- [ ] TDD → コミット `feat(cli): auto-run behavior crud when DB+reseed configured; fills persisted`

---

## #3: tx にページ文脈を刻み sitemap×traffic を相互参照

**問題**: `ApiTransaction`（`transaction.ts:2-22`）はページ文脈を持たず、`sitemap`（画面遷移）と `traffic`（通信ログ）を結ぶ join キーが無い。「どの遷移でどのデータ更新が起きたか」を viewer で辿れない。

**方針（実現可能な範囲）**: tx に「発生時のページURL」を刻み、viewer でそれを sitemap ノードに紐付ける。
- `recorder.ts`: `RecRequest` に optional `frame?(): { url(): string }` を追加（`:18-25`）。`record()` で `pageUrl = normalize(req.frame?.().url())`（同一オリジンのみ、取得不可なら未設定）を算出し tx に載せる。
- `transaction.ts`: `ApiTransaction` に `pageUrl?: string` を追加。
- viewer `traffic-model.ts`: `TrafficRouteGroup` の各 tx に `pageUrl` を通し、`joinTrafficPages` の `TrafficPage.url`（`:231-256`）と突き合わせて「このページ遷移で発生した mutation 一覧」を相互参照できるフィールドを追加（sitemap ノード → 発生 tx 群、tx → 発生ページ）。
- `behavior-sitemap.js` / `behavior-traffic.js`: 相互リンク表示（sitemap ノードに mutation 件数バッジ、traffic 行に発生ページ表示）。

**out-of-scope（明示）**: エッジ**単位**（どの click/link が引き金か）の時系列厳密対応は、NavEdge と tx の共通時間軸が無いため見送り。ページ**単位**の相互参照までを本タスクのスコープとする。

**テスト**: `recorder` テストで fake `frame()` から `pageUrl` が載ること／取得不可でも落ちないこと。`traffic-model` テストで tx↔page の相互参照フィールドが組まれること。

- [ ] TDD → コミット `feat(behavior+viewer): stamp tx page context; cross-link sitemap and traffic`

---

## #2: persisted を per-transaction ノード化

**問題**: `emitTransactionNodes`（`emit.ts:116-156`）は tx を**正規化ルートで dedup**し、同一ルートの複数 tx は最初の1件だけノード化。`persisted` もルート単位（`annotatePersistence` が `step.route === key` で照合、`tx-persistence.ts:36-44`）。記録済み tx の一意 ID `(runId, seq)` は emit で捨てられている。

**方針（実現可能で正直な範囲）**: 記録された各 mutation tx を**個別ノード化**し、ルート由来 verdict を各 tx に付与。
- `emit.ts`: ルート dedup を止め、tx ノード ID に `seq` を含める（`behavior:tx/<route>#<seq>` 等）。GET 等の非 mutation は従来通り集約でも可。
- `contract/model.ts`: `LayerNode` に `seq?: number`（または `txId?`）を追加し per-tx 追跡を可能に。`persisted` は各 tx ノードに付く。
- viewer `traffic-model.ts`: `extractTxPersistence`（`:160-168`）と `joinTrafficRoutes`（`:176-216`）を、ルート単位集約から tx 単位表示に対応させる（同一ルート内で tx ごとに verdict を出せる構造に）。
- reconciler など route キーで behavior ノードを参照する箇所は、集約ビュー（route 単位）を維持できるよう後方互換に注意（route フィールドは残す）。

**out-of-scope（明示）**: 「記録済みブラウザ tx 1件ごとに DB を個別プローブする」完全 per-tx オラクルは見送り。crud executor は**自前の合成リクエスト**で route 単位の判定しか持たない（`execute.ts` / `crud/types.ts`）ため、真の per-tx DB 検証はオラクル再設計を要する。本タスクは「per-tx **ノード**＋route 由来 verdict」までとし、完全 per-tx プローブは将来課題として記録する。

**テスト**: `emit` テストで「同一ルートの2 tx が2ノードになり各々 seq を持つ」。`tx-persistence`/`traffic-model` テストで per-tx ノードに verdict が付与され、route 集約ビューも壊れないこと。既存の behavior/viewer テストが緑のまま。

- [ ] TDD → コミット `feat(behavior+contract+viewer): per-transaction tx nodes carrying persisted verdict`

---

## 最終検証

- [ ] `pnpm -r build` / `pnpm -r lint` / `pnpm -r test` 全 green
- [ ] main へ `--no-ff` マージ
