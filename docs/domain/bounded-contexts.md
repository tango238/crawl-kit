# Bounded Contexts

> 由来: [discovery.md](./discovery.md)（Core=検証）＋ [event-storming.md](./event-storming.md)
> （Verification を reconciliation の後段へ／behavior=観測のみ／Adjudication は別文脈）。

## Context Map 概要図

```
 [Intent] ──→ [Reconciliation] ── unified ──→ [Verification ★Core] ──→ [Reporting]
 [Structure] ─┘     ▲                              │ 反証→Verdict
 [Observation]──────┘                       [Convergence] feedback/known-state（横断）
 [Spine/Contract] 全文脈が依存する背骨 ／ [Scenario Lifecycle] grow→approve→検証ケース
```

## Bounded Context 一覧

### Verification（検証＋裁定）— **Core**
- **責務**: reconcile 済みの三層（unified）と実行中アプリを突き合わせて検証し **Finding** を生み、
  **その場で反証パネルにかけて Verdict まで下す**（検証と裁定は一連・同一文脈）。
- **主要概念**: `Finding`(Diff/Verify)、`Expectation`、`Conformance`、`Scenario`(実行)、`Run`、
  ＋（裁定）`RefuterVote`、`Lens`(correctness/security/intentionality)、`Verdict`(bug/unnecessary/uncertain)、`Confidence`。
- **ユビキタス言語**: 検証 / 期待 / 適合・不適合 / カテゴリ(layout/security/access-control/conditional/registered-data/error-handling) / 入力探索 / 反証 / レンズ / 確信度。
- **位置**: reconciliation の**後段**。入力 = `unified.json + registry + 実行アプリ`。
- **note**: 反証ゲート（偽陽性を殺す trust）は **Core の内部ステージ**として統合（ユーザー決定: 1 BC にまとめる）。
  Reconciliation の同一性裁定とは引き続き**別文脈**（"Verdict" の語義が異なる＝境界維持。divergence #5）。
- **由来コード**: loop-e2e の verify/explore/scenario/refute（behavior から分離予定 = divergence #6）。

### Observation（観測）— Supporting
- **責務**: 実行中アプリをクロールし、ページを LLM で構造化して **as-run の事実**を出す（検証はしない）。
- **主要概念**: `Crawl`、`Page`/`PageInfo`、`SiteStructure`、`Transition`。
- **UL**: クロール / ページ / 遷移 / 表示項目・入力項目 / 能力・期待。
- **由来コード**: loop-e2e collect + services/browser + 構造化（= 縮小後の packages/behavior）。

### Structure Extraction（構造抽出）— Supporting
- **責務**: ソースを静的解析し **as-built モデル**（entity/route/usecase/CRUD/topology）を出す。
- **主要概念**: `Entity`、`Route`、`Usecase`、`Crud`、`Correction`(補正オーバーレイ)。
- **由来コード**: packages/structure（rdra-analyzer 移植）。

### Intent（意図）— **Generic/External**（非所有）
- **責務**: ユビキタス言語＝正準名・正準ID を供給する。
- **主要概念**: `Concept`、`CanonicalName`、`Glossary`。
- **note**: distill-ddd が供給。crawl-kit は所有しない（discovery: D が非コアな理由）。

### Reconciliation（照合）— Supporting
- **責務**: 三層を正準IDで結合し、同一性を裁定・分類して `unified` を出す。人の判断を registry に焼き込む。
- **主要概念**: `Concept`/`ConceptId`、`Evidence`、`ConceptState`、`Relation`、`Registry`、`Unified`、`Decision`。
- **note**: 検証の**期待を整える土台**。intent 辺(8状態/ADR)は intent 非所有ゆえ Supporting（discovery divergence #3）。

### Convergence / Known-state（収束）— Supporting（横断）
- **責務**: feedback を検証し known-findings に焼き込み、同じ Finding を再浮上させない（burn-in）。
- **主要概念**: `Feedback`、`KnownFinding`、`Fingerprint`。
- **note**: Reconciliation の decisions/corrections と**並行する焼き込み機構**（別実装・統合しない）。

### Reporting（報告）— Generic
- **責務**: Finding/Verdict を集約しレポート化、GitHub issue 化。
- **主要概念**: `Report`、`Activity`、`Issue`。

### Scenario Lifecycle（シナリオ育成）— Supporting
- **責務**: クロール＋ソース理解から検証シナリオ草案を出し（grow）、人が採用（approve）。
- **主要概念**: `Scenario`(proposed/active)、`Coverage`。

### Spine / Contract（背骨）— Generic
- **責務**: 全文脈が依存する共有型・正準レジストリ・atomic I/O・emit。
- **主要概念**: `LayerNode`、`Registry`、`Unified`、`emit`。

## 言語の境界で発見した事実（同じ語が文脈で別の意味）

- **Verdict**: Adjudication=「この Finding はバグか」（FindingVerdict）／ Reconciliation=「これは同じ概念か」（ConceptState）。**同語・別意味 → 別 BC を裏付け**。
- **Evidence**: Reconciliation=マッチ信号(name/attributes/topology)／ Adjudication=RefuterVote。別物。
- **Finding（検証の食い違い）** ≠ **Divergence（reconcile の層またぎ差分）**。近いが別概念。
- **burn-in**: Convergence(known-findings) と Reconciliation(decisions/corrections) の**二系統**（別文脈で並存）。

## サブドメイン分類

| 種別 | BC |
|---|---|
| **Core** | Verification（検証＋裁定。反証ゲートを内部に含む） |
| **Supporting** | Observation / Structure Extraction / Reconciliation / Convergence / Scenario Lifecycle |
| **Generic/External** | Intent(distill-ddd) / Reporting / Spine・Contract |

→ 全 **8 BC**（Verification と Adjudication を統合）。

## 決定済み

- **Verification ＝ 1 BC**（検証と裁定を統合）。反証ゲートは Core の内部ステージ＝**Core**。
- Reconciliation とは別文脈を維持（"Verdict" の語義差が境界の根拠）。

## 未解決の問い

- Convergence の burn-in と Reconciliation の burn-in を**共有ライブラリ化**するか（語彙は別のまま）。
- 検証の「期待」に intent をどこまで使うか（intent 非所有のため最小依存に留めるか）。
