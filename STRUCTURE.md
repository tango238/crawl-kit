# STRUCTURE — 構成案

確定したアーキテクチャの構成案。`contract.ts` を背骨に、三層(intent / structure / behavior)を
共通IDで束ね、reconciler が差分を `unified.json` に落とし、viewer が描く。

> **共有クロールパッケージは無い。** rdra が構造専任になりクロールを持たなくなったため、共有すべきクロール機構が
> 存在しない。クロール/シナリオ/E2E は **behavior(loop-e2e)** の中だけに住む。

---

## トップレベル

```
repo/                          # pnpm workspace
  package.json                 # workspace ルート
  pnpm-workspace.yaml          # packages/* と skills/* を宣言
  tsconfig.base.json           # 共通 TS 設定（packages が extends）
  packages/
    contract/                  # 背骨：型 + スキーマ + 検証 + I/O
    reconciler/                # マッチング + 状態分類 + 層またぎ verify
    viewer/                    # unified.json を描く（状態なし）
    structure/                 # rdra port（静的抽出のみ）
    behavior/                  # loop-e2e 吸収（クロール/シナリオ/E2E/検証を所有）
    llm/                       # （任意・後述）Anthropic API / Claude Code CLI の共通クライアント
  skills/
    ddd/                       # distill-ddd（参照のみ。glossary を intent 供給）
  data/                        # registry.json（永続）と unified.json（派生）の置き場
    registry.json
    unified.json
```

データの流れ:

```
distill-ddd ─(glossary.json: intent nodes + 正準ID発行)─┐
rdra(structure) ─(structure nodes + route key)──────────┤
loop-e2e(behavior) ─(findings/scenarios + route key)────┘
                                                         │
                                                         ▼
                                                   reconciler
                                  ┌── 読/書 ──> data/registry.json（永続・人の判断を焼き込む）
                                  └── 書 ─────> data/unified.json（派生・使い捨て）
                                                         │
                                                         ▼
                                                       viewer（描くだけ）
```

---

## packages/contract — 背骨

唯一、他の全員が依存するパッケージ。型の単一の真実。

```
contract/src/
  model.ts        # contract.ts の中身（Concept / Adr / Relation / Registry / Unified …）
  validate.ts     # 参照整合性：dangling な conceptId/adrId を許さない。失敗で書き込み中断
  io.ts           # registry.json / unified.json の atomic read/write
  index.ts        # re-export
```

- `validate.ts` は loop-e2e がすでに持つ「常に参照的に妥当・検証失敗で abort」をそのまま昇格させる。
- 他パッケージは型を `@crawl-kit/contract` から import するだけ。

## packages/reconciler — 照合（Supporting）

> DDD ディスカバリの結論: Core は **検証（Verification）** であり、reconciler は検証の「期待」を整える
> **Supporting**（名寄せ・照合の土台）。intent 辺を所有しないため差別化の核ではない。詳細は
> [docs/domain/discovery.md](./docs/domain/discovery.md) / [bounded-contexts.md](./docs/domain/bounded-contexts.md)。

層のノードを食べ、同一性を判定し、状態を分類し、ADR で裁定し、`unified.json` を吐く。
**「自動 or 手動」は別機能ではなく `direction` と `threshold` の2パラメータに畳む。**

```
reconciler/src/
  ingest.ts       # 各層の emit を LayerNode[] として取り込む
  match/
    name.ts       # 語彙シグナル（弱・ノイジー）
    attributes.ts # 属性集合の重なり（構造的に最強）
    topology.ts   # 関係トポロジーの一致
    behavior.ts   # 同じ操作が触るか（command/event ↔ UC×CRUD）
    llm.ts        # 上の構造証拠を入力に渡して接地させた LLM 判定
    index.ts      # 決定的(構造)を先に計算 → 残りだけ llm。Evidence を返す（単一スコアにしない）
  classify.ts     # ConceptState を決定（aligned / intent-only / code-only /
                  #   aggregate-internal / implementation-detail / adjudicated /
                  #   violates-decision / unmatched）
  adr.ts          # ADR の constraints をトポロジーに照合 → adjudicated / violates-decision
  verify.ts       # rdra から吸収：シナリオ×画面の突き合わせ（層またぎ照合）
  queue.ts        # threshold 未満 → 手作業キュー。人の判断を registry に焼き込む（次回は聞かない）
  pipeline.ts     # ingest → match → (direction,threshold) → classify → adr → emit
  index.ts
```

- マッチは **1:1 を仮定しない**(集約1 ↔ テーブル複数)。`Relation` の多対多で持つ。
- 「孤児だ」と言う前に **`part-of`（マッチ済み集約の境界内か）を先に見る**。これで怖い未マッチの
  大半が穏やかな aggregate-internal に変わる。

## packages/viewer — 一箇所

`unified.json` を読んで差分を描く。**状態を持たない**(registry は触らない)。
ConceptState がそのまま色の凡例。divergence の edge が赤くなる所。

```
viewer/
  src/                # v1 は素朴でいい：概念を選ぶ → intent/structure/behavior が並ぶ → 食い違いが色づく
  index.html
```

- rdra の `viewer.html` と loop-e2e の `report.md` を置き換える最終的な単一ビュー。

## packages/structure — rdra port（静的のみ）

rdra-analyzer の**静的抽出コアだけ**を TS へ。クロール・シナリオ・E2E・viewer は来ない。

```
structure/src/
  analyze/
    source-parser.ts      # ← analyzer/source_parser.py
    screen-analyzer.ts    # ← analyzer/screen_analyzer.py
    usecase-extractor.ts  # ← analyzer/usecase_extractor.py
    information-model.ts   # ← rdra/information_model.py
  rdra/
    diagrams.ts           # ← rdra/*_diagram.py + mermaid_renderer.py（Mermaid 出力）
  gap/
    crud.ts               # ← gap/crud_analyzer.py
  emit.ts                 # 抽出結果を structure-layer LayerNode[] へ（route key 付き）
  index.ts
```

来ないもの（→ 行き先）: `scenarios`,`e2e` → behavior / `verify` → reconciler / `viewer` → viewer。

## packages/behavior — loop-e2e 吸収

loop-e2e ほぼそのまま。**クロール/シナリオ/E2E/検証はすべてここが所有**。
`rdra-export`(点と点の縫合)は廃止し、contract への emit に置き換える。

```
behavior/src/
  crawl/        # Playwright クロール（loop-e2e の collect/explore のクロール部）
  scenario/     # grow / approve（シナリオ生成・採用）
  run/          # collect → diff → verify(5カテゴリ) → scenarios → persist
  findings/     # findings store（共通通貨）
  report/       # 集約・反証ゲート・GitHub issue
  emit.ts       # findings/scenario を behavior-layer LayerNode[] へ（route key 付き）← 旧 rdra-export の正しい姿
  index.ts
```

## packages/llm —（任意）共通 LLM クライアント

rdra も loop-e2e も「`USE_CLAUDE_CODE` で Anthropic API ↔ Claude Code CLI を切替」を各自持っていた。
structure を TS 化すると **同じ抽象が二重になる**ので、ここで一本化する候補。
ただし v1 では無理に切り出さなくてよい(各パッケージ内に置いて後で抜いても可)。

## skills/ddd — distill-ddd（参照のみ）

コードは統合しない(CLIエージェントのホームに住むスキルなので独立必須)。**契約だけ**つながる。
intent 層を供給し、**正準ID(canonicalName)の発生源**になる。

- 必要な小作業: 現状 `docs/domain/*.md` は散文。contract に流すには `glossary.json`
  (concept ごとに id・canonicalName・aliases・属性)が要る。
  選択肢A: distill-ddd 側に emit ステップを足す（発生源で構造化・きれい）／
  選択肢B: reconciler に markdown パーサを置く（distill-ddd を触らない・早い）。
  → **intent 辺に着手する時に決める**。route 辺が先なので今は保留でよい。

---

## 着手順

1. **contract**（済：`contract.ts`）。model → validate → io。
2. **route 辺を一本通す**(structure↔behavior)。最初の動くデモ:
   - `structure/emit.ts` と `behavior/emit.ts` に route key 付き LayerNode を吐かせる
     (rdra の `normalizeRoute` 相当を reconciler/match に置く)。
   - `reconciler/match`（route のみ）→ `classify`（最小）→ `unified.json`。
   - `viewer` は素朴に。**ここで差分が初めて色づく** = 展開に効くデモ。
3. **intent 辺**：glossary.json を供給（上のA/Bを決める）→ name/attributes/llm マッチを足す。
4. **ADR オーバーレイ**：`adr.ts` を有効化 → adjudicated / violates-decision が出る。
5. **手作業キュー & registry 焼き込み**：2回目以降は新規だけ聞く。
