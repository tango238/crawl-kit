# 設計: behavior の CRUD 成功パス能動実行（spec C+D）

- 日付: 2026-07-02
- 対象リポジトリ: `crawl-kit`（pnpm workspace, TypeScript）
- 前提 spec: [A+B 観測基盤](./2026-07-01-crud-api-observation-ab-design.md)（実装・テスト緑で完了）
- 状態: 承認済み（standing goal「推奨案で最後まで」により案1採用）。実装計画は writing-plans で別途作成。

## 背景

A+B で「同一オリジン API の記録」「method 対応 behavior ノード」「boundary の `saved` 受け皿」「DB 接続」まで揃った。
ただし A+B は**観測のみ**で、`saved` は未充填、DELETE の実行・確認は無い。C+D は behavior に
**CRUD 成功パスの能動実行**を足し、A+B が用意した受け皿を実データで満たす。

## スコープ

### やること
- **C（事前解析アーティファクト）**: 各エンティティの「CRUD 計画」を導出して永続化する。
  各計画は create/update/delete のエンドポイントと、投入する妥当な入力値を持つ。
- **D（能動実行 + 成功オラクル）**: 計画に沿って **API 駆動**で `POST → GET → PATCH → DELETE` を叩き、
  各段の成功を DB プローブ（存在／値一致／不在）＋レスポンス status で判定する。成功パスの失敗は finding。
- **`saved` 充填**: 作成/更新の観測結果を emit の tx ノード `raw.saved` に載せ、boundary を `roundtrip-ok` にする。
- **absence 判定**: `dbProbe` に「行が消えたか」を追加し、DELETE を裏取りする。

### やらないこと
- UI の削除ボタン/確認ダイアログ探索（API 駆動で回避）。
- 任意アプリの複雑な多段フォーム、認証をまたぐ多アクター CRUD（将来）。
- 入力バリデーション（reject）探索は既存 explore が担当（本 spec は成功パス専用）。

## 採用アプローチ: API 駆動 CRUD ライフサイクル（案1）

structure は既にルートを method + CRUD(C/U/D) + entity でモデル化している。これを使って、認証済みブラウザ
コンテキストから REST エンドポイントを直接叩く。UI フォーム探索に依存しないため、**DELETE の不在確認まで決定的**に到達できる。

```
crud-plan（C: 事前解析）
  └─ per entity: { table, idColumn, create: {method:POST, path}, update?: {PATCH, path}, delete?: {DELETE, path}, body }
        │
        ▼  crudExecutor（D: 認証済み page.request で実行）
  POST create.path  body=derived      → status 2xx? 作成 id を応答/DB から取得
  GET  :id                            → 取得できる?
  PATCH :id  body={updatableCol:new}  → DB で値が new に変わった?
  DELETE :id                          → DB で行が消えた?(absence) / GET :id が 404?
        │
        ▼  成功オラクル
  各段の失敗 → VerifyFinding(category:'crud')。作成/更新成功 → saved（列名）を記録
        │
        ▼  emit: tx ノード raw.saved を充填 → boundary roundtrip-ok
  recorder（A+B）が全 API 通信を transactions.jsonl に記録（証跡）
```

## コンポーネント

### C: crud-plan 導出（`services/crud/plan.ts`）

- 入力: structure ルート群（method 対応・crud・entity/table 付き）、DB 接続、既存 `introspectTable`/`modelConstraints`/`buildBaseline`。
- エンティティ（= table）ごとに:
  - `create`: そのテーブルへの `POST` ルート。
  - `update`: `PATCH`/`PUT` かつパスに id パラメータを持つルート。
  - `delete`: `DELETE` かつ id パラメータを持つルート。
  - `idColumn`: 主キー列（introspection の第一候補は `id`。無ければ最初の not-null 一意っぽい列）。
  - `body`: **導出優先順位** — ①観測済み POST トランザクションのリクエストボディ形（recorder 由来、実フィールド名）→ ②発見済み create フォームのフィールド名 → ③DB の挿入可能列（id/timestamps 除外、snake_case ベストエフォート）。値は `modelConstraints`＋`buildBaseline` の妥当値を使い、一意制約回避のため一部にタイムスタンプ/連番サフィックスを付す。
  - `updatableColumn`: 更新で変える列（NOT NULL でない・id/timestamp でない可変列を1つ）。
- 出力: `.e2e/runs/<runId>.crud-plan.json`（＋emit 段で `data/behavior.crud-plan.json` へ橋渡し、viewer で閲覧可）。
- 実行を伴わない純導出（テスト容易）。

型（抜粋）:
```ts
type CrudPlan = {
  entity: string
  table: string
  idColumn: string
  create?: { method: string; path: string }
  update?: { method: string; path: string; updatableColumn: string }
  delete?: { method: string; path: string }
  body: Record<string, unknown>
}
```

### D: crudExecutor（`services/crud/execute.ts`）

- 認証済みコンテキストの API リクエスト機能（Playwright `page.request` / `context.request`）で計画を実行。全 I/O は注入。
- 手順（1エンティティ）:
  1. `POST create.path` with `body` → status を確認。作成 id を **①応答 JSON の id フィールド（既定 `id`）→ ②DB の idColumn 最大値** から取得。
  2. `GET .../<id>` → 取得可を確認（任意・存在確認の補助）。
  3. `PATCH update.path(<id>)` with `{ [updatableColumn]: newValue }` → DB で `updatableColumn === newValue` を確認。
  4. `DELETE delete.path(<id>)` → DB で行が不在（`wasValueAbsent`）を確認。
- 各段は独立に finding を出せる（create 成功・update 失敗など部分結果を許容）。
- 秘匿マスクは A+B の記録側で担保（executor はボディを直接ログに出さない）。

### 成功オラクル + absence 判定（`services/crud/oracle.ts` + `dbProbe.ts` 追記）

- `dbProbe.ts` に `wasValueAbsent(db, dbType, table, idColumn, idValue): Promise<boolean>`（`rows.length === 0` を返す。エラー時は false=不在断定しない）。
- オラクル: 各段の成功条件を満たさなければ `VerifyFinding`:
  - create 失敗（非2xx or 行が存在しない）→ `category:'crud'`, high, "作成が反映されない"。
  - update 失敗（値が変わらない）→ high, "更新が反映されない"。
  - delete 失敗（行が残る）→ high, "削除されない"。
  - すべて成功 → finding なし。作成/更新で `saved`（確認できた列名）を記録し executor 結果に含める。

### saved 充填（emit 連携）

- crudExecutor の結果（route ごとの `saved: string[]`）を、emit の tx ノード生成に渡し `raw.saved` に載せる。
- これで A+B の boundary 受け皿が実データで満たされ、C/U 境界が `roundtrip-ok` になる（未確認は従来どおり `persistence-unobserved`）。
- 実装: `emitTransactionNodes(txs, runId, savedByRoute?)` に任意引数を足す（後方互換）。

### 安全ガード（必須・explore 流用）

- crudExecutor は破壊的。既存 explore と同じガードを課す: `launch.seed` が設定済み、または `--no-reseed` 明示が無ければ**実行拒否**。
- 実行後は既存 `seedDatabase` で DB を復元（explore と同じ Stage）。
- 認証失敗時は最初の書き込み前に中断。

### CLI/配線

- `run --crud`（または `crud` サブコマンド）で C→D を実行。既存 `run --explore` の配線（authed context・recorder・seed/reseed）を踏襲。
- recorder（A+B）は既に全ページに attach 済み。crudExecutor が `page.request` を使う場合も、同一コンテキストの通信は記録経路に載る（載らない場合は executor 側で明示記録）。

## エラー処理

- crudExecutor はエンティティ単位で try/catch。1エンティティの失敗は finding 化して次へ（全体は止めない）。
- DB プローブ・API 呼び出しの例外は warn + 該当段を「未確認」として扱い、成功断定しない。
- plan 導出でエンドポイントや id 列が特定できないエンティティはスキップ（warn、finding にしない）。

## テスト

- **plan.ts**: structure ルート＋列定義（フェイク）から、create/update/delete と body/idColumn が正しく導出される。POST 未検出エンティティはスキップ。
- **dbProbe wasValueAbsent**: 行なし→true、行あり→false、エラー→false。
- **oracle**: create/update/delete 各失敗パターンで finding、全成功で finding なし＋saved 返却。
- **execute**: フェイク API クライアント＋フェイク DB で POST→PATCH→DELETE の順・id 伝播・各オラクル呼び出しを検証。
- **emit**: `savedByRoute` を渡すと tx ノード `raw.saved` に載る（boundary が roundtrip-ok を出せる）。
- **ガード**: seed 無し・no-reseed 無しで実行拒否。

## 段階（実装順）

1. `dbProbe.wasValueAbsent`（小・独立）。
2. C: `crud/plan.ts`（純導出）＋アーティファクト書き出し。
3. D: `crud/oracle.ts` → `crud/execute.ts`（フェイク注入でTDD）。
4. emit `savedByRoute` 連携。
5. CLI 配線（`run --crud`）＋安全ガード。
6. 全体ビルド＋テスト緑、デモ煙テスト。
