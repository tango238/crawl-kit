# P4: behavior 追加分（サイトマップ生成・persisted 印・持ち越し修正） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** behavior 層に①画面遷移ツリー（`data/behavior.sitemap.json`）②mutation トランザクションへの persisted 印③P2/P3 持ち越しの堅牢化（targets ガード・clear の .e2e 対応）を追加し、P5 viewer（通信ログ/画面遷移メニュー）の入力を完成させる。

**Architecture:** クロール BFS（`discoverPages`）に**非破壊のエッジ通知コールバック `onEdge`** を追加してナビゲーショングラフを記録し、`collect` がそれを束ねて `data/behavior.edges.json` に保存。`emit` 時にエッジ+ページからサイトマップツリーを構築して `data/behavior.sitemap.json` を出力。persisted 印は emit の tx ノード生成時に crud 実行結果アーティファクトと突合して付与（能動 CRUD で検証済み → yes/no、未検証 mutation → unknown、GET 系 → なし）。

**Tech Stack:** TypeScript (ESM), Vitest。behavior パッケージ中心。

**親スペック:** `docs/superpowers/specs/2026-07-03-workspace-unified-pipeline-design.md` F 節

## Global Constraints

- ESM / `.js` import。behavior パッケージはセミコロンなし（ファイルごとに確認）。cli はセミコロンあり
- ライブラリコードに console.log 禁止（behavior は既存 logger を使う）
- イミュータブル。TDD（RED→GREEN）。コミットメッセージは各タスク指定
- **既存の公開 API を壊さない**: `discoverPages` の戻り値型・既存引数、`CollectDeps`/`CollectResult` の既存フィールド、emit の既存ノード形は維持（追加のみ）
- DATA_FILES 追加は contract に: `behaviorEdges: "behavior.edges.json"`, `behaviorSitemap: "behavior.sitemap.json"`
- 各タスク: 対象パッケージのテスト全緑 + lint 後にコミット。実装前に対象ファイルを必ず読む（このプランはインターフェース契約を規定し、内部の結線は既存コードの構造に合わせて適応する）

---

### Task 1: behavior — ナビゲーションエッジ記録（discoverPages onEdge）

**Files:**
- Modify: `packages/behavior/src/services/browser/discover.ts`
- Modify: `packages/behavior/src/pipeline/collect.ts`（エッジ収集の結線 + `CollectResult` に `edges` 追加）
- Modify: `packages/contract/src/paths.ts`（DATA_FILES 2 エントリ追加）
- Test: 既存の discover/collect テストに追記（`packages/behavior/src/services/browser/discover.test.ts` 等 — 実在のテストファイル名を確認して合わせる）

**Interfaces:**
- Produces:
  - `type NavEdge = { from: string; to: string; kind: "link" | "click"; label?: string }`（from/to は normalizeUrl 済み URL。discover.ts で export）
  - `discoverPages(page, target, opts, clickDiscovery = false, onEdge?: (edge: NavEdge) => void)` — 末尾 optional 引数（後方互換）。リンク enqueue 時に `kind:"link"`（label は取得可能なら anchor テキスト — `extractLinks` がラベルを持たない場合は label 省略でよい）、クリック遷移発見時（`enqueueClickTransitions` 内で URL 変化を検出した箇所）に `kind:"click", label: ClickTarget.label` を通知
  - `CollectResult.edges: NavEdge[]`（追加フィールド。既存呼び出し元はコンパイルが通ること — 生成側で必ず埋める）
  - collect の BFS 呼び出しに onEdge を渡し、run パイプラインの最後（collect 結果を保存している箇所を読み、同じ流儀で）`data/behavior.edges.json` に `{ runId, edges }` を書く（contract の `dataPath(DATA_FILES.behaviorEdges)` + `writeJsonAtomic` 相当。behavior が contract を import できるかは package.json を確認 — できない場合は behavior 内の既存 fs util + dataPath 相当の既存解決を使い、ファイル名リテラルは DATA_FILES と一致させる）
- テスト: fake page/クローラで 2 ページ + 1 リンク遷移 → onEdge が from/to/kind を正しく受ける。onEdge 未指定で従来挙動（既存テスト全緑）。

- [ ] TDD → コミット `feat(behavior): record navigation edges during BFS + persist behavior.edges.json`

---

### Task 2: behavior — サイトマップ生成（emit 時）

**Files:**
- Create: `packages/behavior/src/sitemap.ts`
- Modify: emit フロー（`packages/behavior/src/emit.ts` と、emit を呼ぶ CLI コマンド `runEmit` 周辺 — 実際の呼び出し経路を読んで最小の結線点を選ぶ）
- Test: `packages/behavior/src/sitemap.test.ts`

**Interfaces:**
- Produces:
  - `type SitemapNode = { url: string; via?: { kind: "link" | "click"; label?: string }; children: SitemapNode[] }`
  - `type Sitemap = { generatedAt: string; roots: SitemapNode[]; orphans: string[] }`
  - `buildSitemap(edges: NavEdge[], pages: string[], opts?: { now?: string }): Sitemap` — 純関数:
    - ノード集合 = pages（訪問済み URL）∪ edges の from/to
    - 木構築: 各ノードの親 = そのノードへ最初に到達したエッジ（edges 配列の出現順で決定的に）。複数親は最初の 1 本のみ子リンクとし、他は無視（DAG→木の単純化）。親を持たないノードのうち、ルート様 URL（パスが "/" or 最短）を roots に。どのエッジにも現れず pages にだけある URL は orphans
    - 循環安全: visited セットで無限再帰を防ぐ
  - emit 時: `data/behavior.edges.json` が存在すれば読み、behavior:page/ ノードの URL 群と合わせて `buildSitemap` → `data/behavior.sitemap.json` へ書き出し。edges が無ければ書かない（黙ってスキップ）
- テスト: 直線 A→B→C／分岐／複数親（最初の親が勝つ）／orphan／循環（A→B→A）で停止、の 5 系統。

- [ ] TDD → コミット `feat(behavior): emit behavior.sitemap.json from navigation edges`

---

### Task 3: behavior — tx ノードへの persisted 印

**Files:**
- Modify: `packages/behavior/src/emit.ts`（tx ノード生成箇所）
- Create: `packages/behavior/src/tx-persistence.ts`（純関数）
- Test: `packages/behavior/src/tx-persistence.test.ts` + emit テスト追記

**Interfaces:**
- 前提調査: `crud` 実行結果のアーティファクト形（`packages/behavior/src/services/crud/types.ts` と、`emit reads saved artifact` 経路 — git log `0d24fd2` の実装）を読む。oracle の成功/失敗（DB probe 含む）が per-operation で残っているはず
- Produces:
  - `type PersistVerdict = "yes" | "no" | "unknown"`
  - `annotatePersistence(tx: { method: string; path: string; status?: number }, crudResults: CrudResultsLike): PersistVerdict | undefined` — 純関数:
    - GET/HEAD/OPTIONS → `undefined`（印なし）
    - mutation（POST/PUT/PATCH/DELETE）: crud 結果に method+path（正規化して比較。:id パラメータは既存の path 正規化流儀に合わせる）が一致し oracle 成功 → "yes"、oracle 失敗 → "no"、crud 結果に無い → "unknown"
  - emit の `behavior:tx/` ノードに `persisted?: PersistVerdict` フィールドを追加（LayerNode は拡張フィールドを許容するか contract の型を確認 — 厳密なら `Record<string, unknown>` 的な余地 or contract の LayerNode に optional フィールド追加。**contract 変更が必要なら最小の optional 追加**とし、validate が strict なら合わせて更新）
- テスト: GET → undefined／crud 済み成功 → yes／crud 済み失敗 → no／未検証 POST → unknown。emit 統合: tx ノードに persisted が乗る。

- [ ] TDD → コミット `feat(behavior): annotate tx nodes with persisted verdict from crud oracle results`

---

### Task 4: 持ち越し堅牢化（collect targets ガード / clear の .e2e / スペック注記）

**Files:**
- Modify: `packages/behavior/src/pipeline/collect.ts`（targets[0] ガード）
- Modify: `packages/cli/src/commands/clear.ts`（behavior フェーズで `.e2e/runs`・`.e2e/reports` と `data/behavior.edges.json`・`data/behavior.sitemap.json` も削除。`baseline`/`known-findings`/`feedback` は残す）
- Modify: `docs/superpowers/specs/2026-07-03-workspace-unified-pipeline-design.md`（A 節に注記: フラグメントキャッシュは実装上リポジトリ直下 `<repo>/.crawl-kit-cache/` に置く（コンテンツアドレスで repo に従属するため）。clear は両方を対象にする、の 2 行）
- Test: collect テスト（targets 空 → 明確なエラー or 空結果 — 既存の behavior CLI ガード（cli/index.ts:168 の selectedTarget ガード）と整合する方を選び、`config.targets[0]` の裸参照を除去）、clear テスト追記

- [ ] TDD → コミット `fix(behavior): guard empty targets in collect; clear resets .e2e runs + sitemap artifacts`

---

### Task 5: 全体検証 + スモーク + README

- [ ] `pnpm -r lint && pnpm -r test && pnpm -r build`
- [ ] スモーク（P2/P3 と同じ scratch workspace 手順）: behavior は blocked のままでよい（playwright なし環境）。**追加**: behavior パッケージの単体レベルで、fake ページによる collect→edges→sitemap の結合テストが存在すること（Task 1-2 のテストで担保されているか確認し、なければ 1 本足す）。`clear --phase behavior` が新アーティファクトを消すことを実 CLI で確認
- [ ] README: behavior 成果物（edges/sitemap/persisted）を成果物一覧と F 節説明に追記
- [ ] コミット `docs: behavior sitemap + persisted annotations usage`

---

## Self-Review 結果

- **スペック F 節網羅**: preflight ゲート = P2 済み。persisted 印 → Task 3。sitemap → Task 1+2。P2 最終レビュー持ち越し（collect targets / .e2e clear / キャッシュ配置の spec 整合）→ Task 4。runBehavior の --target 非対応はマルチターゲット運用が未スコープのため**明示的に見送り**（P5 後のバックログ）。
- **型整合**: NavEdge（Task 1）↔ buildSitemap（Task 2）。PersistVerdict（Task 3）は behavior 内で完結、contract 変更は最小 optional。
- **P5 への出力**: 通信ログメニュー = transactions.jsonl（既存）+ structure ルート照合（P5 側）+ persisted（Task 3）。画面遷移メニュー = behavior.sitemap.json（Task 2）。
- **順序**: Task 1 → 2 → 3（emit を共有するため直列）。Task 4 は 1-3 と並行可だが同一パッケージのため直列実行。Task 5 最後。
