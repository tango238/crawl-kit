# DATA-MODEL

`packages/contract`(`contract.ts`)の散文リファレンス。型の意味と「なぜそうなっているか」。

## 同一性

| 型 | 例 | 説明 |
|---|---|---|
| `ConceptId` | `concept:order` | 概念の正準 ID。**glossary(intent)が発行**。 |
| `AdrId` | `adr:0014` | 意思決定記録の ID。 |
| `NodeId` | `structure:table/order_items` | 層ローカルの成果物 ID。層で名前空間を切る。 |
| `Layer` | `intent` / `structure` / `behavior` | 三つのスタンス。 |

## Concept（正準レコード）

レジストリは `Concept` の集合。

- `canonicalName` — 正準名。理想は glossary のユビキタス言語の語。
- `aliases` — 別名(コード由来名など)。
- `kind` — `aggregate-root / entity / value-object / service / policy`。
- `nodes` — 各層でこの概念を表すノード(`Partial<Record<Layer, NodeId[]>>`)。複数可。
- `state` — 分類結果。色を決める(下記)。
- `decisions` — この概念に効く ADR の ID 群。**空でよい**。
- `resolution` — 状態が人の判断なら、その記録を残し次回再質問しない。

## ConceptState（色の凡例）

このスイートで最も重要な表。二値ではなく八値。

| 状態 | 意味 | 色の意図 |
|---|---|---|
| `aligned` | 在るべき層に在り、整合している | 緑(正常) |
| `intent-only` | 設計したがまだ作っていない | 情報(未実装) |
| `code-only` | コードに在るが意図が無い | 注意(漏れ or 詳細) |
| `aggregate-internal` | 孤児ではない。マッチ済み集約の **内側** に居る | 中立(正当) |
| `implementation-detail` | ドメイン線の下として受容(中間表・session・outbox) | 中立(正当) |
| `adjudicated` | ずれているが ADR が説明している(モデルが追従中) | 情報(既知) |
| `violates-decision` | ずれていて、かつ ADR の制約を **破っている** | 赤(最重要) |
| `unmatched` | 未分類。手作業キューへ | 灰(要対応) |

設計の肝: 「コードにあるが意図に無い」を一律 `code-only`(欠陥扱い)にしない。多くは
`aggregate-internal`(マッチ済み概念の境界内)か `implementation-detail`(線の下)。
偽陽性を出すと信頼が死ぬ。

## Evidence（証拠ベクトル）

同一性判定の「なぜ」。**単一スコアにしない。**

| シグナル | 強さ | 備考 |
|---|---|---|
| `name` | 弱・ノイジー | glossary 語(業務語) ↔ コード由来名 |
| `attributes` | **最強** | 同じフィールドを持てば名前が違っても同一の可能性大 |
| `topology` | 中 | 関係の形が両側で一致するか |
| `behavior` | 傍証 | 同じ操作が触るか(command/event ↔ UC×CRUD) |
| `llm` | 補完 | 上の構造証拠を入力に渡して接地。同義語(顧客/Customer/User)を拾う |

決定的(構造)を先に計算 → 残った曖昧だけ LLM。人は証拠を見て即決でき、その判断が証拠パターン
ごとにレジストリへ焼き込まれる。

## Relation（概念間の関係）

**1:1 を仮定しない。** DDD の集約はエンティティのクラスタ(ルート＋内部)、RDRA の ER は
個々のテーブル寄り。集約1 ↔ テーブル複数が普通。

| `kind` | 意味 |
|---|---|
| `same-as` | 層をまたぐ同一性(`Evidence` を持つ) |
| `part-of` | 集約の境界内に属する → `aggregate-internal` の根拠 |
| `serves` | 技術概念がドメイン概念に奉仕(outbox が events に) |
| `derived-from` | 読み取りモデル/射影が source 概念から派生 |

**「必要だが意図に無いコード」の置き場所がここ。** 中間表・監査ログ・outbox・読み取りモデルは
孤児ではなく、`part-of` / `serves` / `derived-from` でマッチ済み概念に結ばれる。
`decidedBy: "auto" | "human"` でレジストリに焼き込む。

## Adr（意思決定記録）

辺の上に乗る裁定者。四つ目の角ではない。

- **独立レコード**。`affects: ConceptId[]` で概念を参照(1 ADR ↔ 複数 concept の多対多)。
- `status` — `proposed / accepted / superseded / deprecated`。
- `constraints` — 機械照合可能なものは構造トポロジーに当てる。
  - `forbid-dependency` 例: `{ from: "concept:payment", to: "concept:shipping" }` = 「Payment ↛ Shipping」
  - `require-dependency` / `note`。
- **空配列スタート**。スキーマには初日から在るので後付け移行ゼロ。

ADR が `concept:customer` を分割する決定を持てば、structure が分割済みで glossary が旧名のままでも
「欠陥」ではなく「モデルの追従遅れ(adjudicated)」と判定できる。逆に制約を破れば
`violates-decision`。

## Registry と Unified

reconciler が所有する二つのファイル。

| ファイル | 性質 | 内容 | 消費者 |
|---|---|---|---|
| `registry.json` | **永続** | concepts + adrs + relations。人の判断の蓄積 | 全ツールが参照し ID をタグ付け |
| `unified.json` | **派生・使い捨て** | 層をまたいで解決済みの概念行 | viewer が描くだけ |

- レジストリを **browser 状態に閉じ込めない**。閉じ込めると「全員が同じ ID を参照する」性質を失う。
- `validate.ts` は参照整合性を保証(dangling な `conceptId`/`adrId` を許さない)。検証失敗で
  書き込みを中断(loop-e2e の「常に参照的に妥当」を昇格)。

## UnifiedConcept（差分ビューの一行）

`viewer` が読む形。一つの概念を三層で解決した行。

- `intent?` / `structure?[]` / `behavior?[]` — 集約はテーブル複数、概念は findings 複数なので
  structure と behavior は配列。
- `divergences[]` — 赤くする辺。`edge`(`intent↔structure` 等)と `detail`、`adjudicatedBy`
  (ADR が説明)、`violates`(ADR を破る)。
