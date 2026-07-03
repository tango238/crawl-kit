# STRUCTURE — リポジトリ構成

`@crawl-kit/contract` を背骨に、三層（intent / structure / behavior）を共通IDで束ね、
reconciler が差分を `unified.json` に落とし、verification が裏取りし、viewer が描く。
`@tanago3/crawl-kit`（CLI）がこれら全部を1つの spine としてまとめ、ワークスペース単位で通しで走らせる。

> **共有クロールパッケージは無い。** クロール/シナリオ/E2E/CRUD 検証は **behavior（loop-e2e 由来）** の中だけに住む。

---

## トップレベル

```
crawl-kit/                       # pnpm workspace
  package.json                   # workspace ルート（build/test/lint/demo/serve/release スクリプト）
  pnpm-workspace.yaml            # packages/* を宣言
  tsconfig.base.json             # 共通 TS 設定
  packages/
    contract/                    # 背骨：型 + スキーマ + 検証 + I/O + パス/進捗/ワークスペース定義
    intent/                      # intent 層：glossary → 正準concept + 集約 + 自動ドラフト
    structure/                   # 静的解析：インクリメンタル分析 + rdra 図 + emit
    behavior/                    # loop-e2e 吸収：クロール/シナリオ/CRUD/検証を所有
    reconciler/                  # 証拠マッチ + 状態分類 + ADR 裁定 → unified.json
    verification/                # Core：unified を「期待」として検証 → findings/verdicts
    freshness/                   # 取得鮮度：TTL + 内容ハッシュで再取得を間引く
    viewer/                      # ビューア：ダッシュボード + 4メニュー SPA（状態なし）
    cli/                         # @tanago3/crawl-kit（npx エントリ。全部を1コマンドに）
  docs/                          # ARCHITECTURE / DATA-MODEL / OPERATIONS / ROADMAP / adr / domain / superpowers
  data/                          # 成果物（intent/structure/behavior/unified/findings）+ registry.json
```

## データの流れ

```
intent(distill-ddd / 自動ドラフト) ─(intent.nodes + aggregates + 正準ID)─┐
structure(静的解析) ───────────────(structure.nodes + route key)─────────┤
behavior(クロール+CRUD) ───────────(behavior.nodes + edges/sitemap/persisted)┘
                                                                          │
                                                                          ▼
                                                                    reconciler ── registry.json（永続・人の判断）
                                                                          │  └─────> unified.json + mapping.aggregate-entity.json（派生）
                                                                          ▼
                                                                    verification ──> *.findings.json / verdicts
                                                                          │
                                                                          ▼
                                                                      viewer（描くだけ）
```

CLI（`crawl-kit run`）がこの流れ全体をワークスペース単位で駆動し、進捗を `.crawl-kit/progress.json` に台帳化、viewer を自動起動する。

---

## packages/contract — 背骨

唯一、他の全員が依存するパッケージ。型の単一の真実。**何にも依存しない（背骨は葉）。**

```
contract/src/
  model.ts        # Concept / Adr / Relation / Registry / Unified / LayerNode …
  validate.ts     # 参照整合性：dangling な conceptId/adrId を許さない。失敗で書き込み中断
  io.ts           # registry.json / unified.json 等の atomic read/write
  paths.ts        # DATA_FILES（成果物ファイル名）とパス解決
  workspace.ts    # findWorkspaceRoot / findRepoRoot（.crawl-kit/workspace.yaml 探索）
  progress.ts     # 進捗台帳（progress.json）の型と遷移ヘルパ
  route.ts        # normalizeRoute（"METHOD /path" 正準キー。structure↔behavior の強い鍵）
  concurrency.ts  # makeLimiter / resolveClaudeCodeConcurrency（CLAUDE_CODE_MAX_CONCURRENCY, 既定3）
```

## packages/intent — intent 層

glossary（distill-ddd 由来、または自動ドラフト）を正準 concept として供給し、正準名/IDの発生源になる。

```
intent/src/
  glossary-schema.ts # intent.json（Glossary）契約スキーマ
  model.ts           # intent モデル
  aggregates.ts      # 集約とその構成概念 → intent.aggregates.json
  draft.ts           # intent.json が無いとき LLM で骨組みを自動ドラフト
  emit.ts            # intent-layer LayerNode[] へ（+ aggregates emission）
  cli.ts
```

## packages/structure — 静的解析

ソースコードから route/コントローラ/モデル/ユースケース/情報モデルを抽出。**インクリメンタル分析**（unit×pass、内容ハッシュでキャッシュ＝差分）と従来の一括解析の両方を持つ。

```
structure/src/
  analyze/
    units.ts / fragments.ts / scoped-parser.ts / merge.ts / passes.ts / incremental.ts
                        # 増分・分散・段階アナライザ（repo→unit→fragment cache→merge→pass）
    source-parser.ts    # 一括ソース解析（従来経路）
    usecase-extractor.ts / information-model.ts / events.ts
    context/            # フレームワーク知識・プロジェクト文脈
    derived/            # 派生抽出
    llm/                # LlmProvider（Anthropic API / Claude Code CLI 切替。オフラインは決定的フォールバック）
  rdra/                 # ユースケース図/ER図（Mermaid 出力）
  gap/                  # crud gap 分析
  emit.ts               # structure-layer LayerNode[] へ（route key 付き）
  corrections.ts / outputs.ts / crud.ts
```

## packages/behavior — loop-e2e 吸収

クロール/シナリオ/CRUD/検証をすべて所有。実アプリをブラウザ駆動でクロールし、通信・画面遷移・データ保存を観測する。

```
behavior/src/
  services/             # browser（recorder/discover）・crud（plan/execute/oracle）・explore（dbProbe）等
  pipeline/             # collect（クロール収集）・explore・diff
  crawl / scenario      # BFS+クリック発見 / grow・approve（シナリオ）
  cli/commands/         # run / crud / emit / explore / grow / report … （loop-e2e CLI）
  config/               # workspace.yaml/e2e.config.yaml スキーマ
  domain/               # ApiTransaction（seq/ts/pageUrl…）等のドメイン型
  sitemap.ts            # NavEdge + ページから画面遷移ツリー（roots/orphans）
  tx-persistence.ts     # mutation tx の persisted 判定（yes/no/unknown、dbProbed ゲート）
  emit.ts               # behavior-layer LayerNode[] へ（route key + per-tx ノード + persisted）
  state / util
```

## packages/reconciler — 照合（Supporting）

層のノードを食べ、同一性を判定し、状態を分類し、ADR で裁定し、`unified.json` を吐く。

```
reconciler/src/
  ingest.ts / nodes.ts   # 各層の emit を LayerNode[] として取り込む
  match/                 # name / attributes / topology / behavior / llm（決定的→llm、Evidence を返す）
  classify.ts            # ConceptState（aligned / intent-only / code-only / aggregate-internal /
                         #   implementation-detail / adjudicated / violates-decision / unmatched）
  adr.ts                 # ADR 制約をトポロジーに照合 → adjudicated / violates-decision
  aggregate-mapping.ts   # unified + aggregates から集約×エンティティ相関 → mapping.aggregate-entity.json
  queue.ts               # threshold 未満 → 手作業キュー。判断を registry に焼き込む
  pipeline.ts / cli.ts
```

## packages/verification — 検証（Core）

reconcile 済みモデルを「期待」として検証する、スイートの中心。

```
verification/src/
  verify.ts / boundary.ts   # concept 検証 + route ごとの入力→表示→保存の境界照合
  adjudicate.ts             # bug / uncertain / unnecessary + ADR 裁定
  model.ts / cli.ts
```

## packages/freshness — 取得鮮度

TTL + 内容ハッシュで structure/behavior の再取得を間引く。

```
freshness/src/
  hash.ts / freshness.ts / store.ts / model.ts   # hashContent + 取得台帳（acquisition store）
```

## packages/viewer — ビューア（状態なし）

サーバ側で view-model を組み、ビルド不要の素の ES modules SPA（ハッシュルーティング）で描く。**registry は触らない。**

```
viewer/
  src/                  # api.ts（ルートマップ）/ server.ts（配信）/ diff-assemble・diff-view /
                        #   dashboard-model / intent-model / traffic-model / view-model
  public/               # index.html（シェル）/ app.js（ルータ）/ style.css / mermaid-render.js
    views/              # dashboard / intent-* / structure-* / behavior-traffic・sitemap / map-*（観測マップ）
```

## packages/cli — `@tanago3/crawl-kit`（npx エントリ）

全パッケージを1つの spine としてまとめる。esbuild で**依存ゼロの自己完結バンドル**（`dist/index.js`）に固め、内部 `@crawl-kit/*`（すべて private）を同梱して npm 公開する。

```
cli/src/
  index.ts              # コマンドディスパッチ + npx エントリ
  commands/
    setup.ts / doctor.ts / migrate.ts     # ワークスペース初期化・プリフライト・移行
    run.ts / run-phases.ts / behavior-spawn.ts   # 統合実行（intent→…→verify）とフェーズ本体
    clear.ts / serve.ts                   # クリア（再生成）・ビューア起動
    repo-analysis.ts / structure-merge.ts / aggregate-mapping-io.ts / prompt.ts / yaml-io.ts
  samples/              # demo 用の同梱サンプル（intent/structure/behavior）
```

---

## LLM バックエンド

`USE_CLAUDE_CODE` で Anthropic API ↔ Claude Code CLI を切り替える規約は各パッケージが踏襲する
（実体は `structure/src/analyze/llm/`）。どちらも未設定ならオフラインの決定的フォールバックで動き、
曖昧な分は手作業キューに回る（再現可能）。同時実行数は `CLAUDE_CODE_MAX_CONCURRENCY`（既定 3）で制御。

## 元ツール

crawl-kit は置き換えではなく、3つに共通の背骨を与える。

- [**distill-ddd**](https://github.com/tango238/distill-ddd) — 対話的 DDD モデリング。**intent** を所有・正準名を発行。
- [**rdra-analyzer**](https://github.com/tango238/rdra-analyzer) — ユースケース/情報モデルの静的抽出。**structure** の源流。
- [**loop-e2e**](https://github.com/tango238/loop-e2e) — AI 駆動クロール+検証ループ。**behavior** を所有。
