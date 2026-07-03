# Domain Events

> 由来: [event-storming.md](./event-storming.md) のイベント時系列＋ [aggregates.md](./aggregates.md) の集約。
> Core=検証。Event Flow は「観測 → 照合(unified) → 検証(後段) → 報告／収束」の連鎖。

## イベント一覧

### Observation（観測）

#### AppCrawled
- **発生元 Aggregate**: SiteStructure
- **トリガー**: `capture(crawl)`（Playwright クロール）
- **プロパティ**:
  - `pages`: RawPage[] — 収集したページ
  - `occurredOn`: Timestamp
- **Consumer**: Observation
- **Enrichment/Query-Back**: Enrichment（生ページを同梱）

#### SiteStructureExtracted
- **発生元 Aggregate**: SiteStructure
- **トリガー**: `extract(llm)`（LLM 構造化）
- **プロパティ**:
  - `pages`: PageInfo[] — 表示項目・入力項目・期待・能力
  - `occurredOn`: Timestamp
- **Consumer**: Observation
- **Enrichment/Query-Back**: Enrichment

#### BehaviorEmitted
- **発生元 Aggregate**: SiteStructure
- **トリガー**: `emit()`（背骨へ）
- **プロパティ**:
  - `nodes`: LayerNode[] — route-keyed な as-run 事実
  - `occurredOn`: Timestamp
- **Consumer**: Reconciliation
- **Enrichment/Query-Back**: Enrichment

### Reconciliation（照合）

#### UnifiedGenerated
- **発生元 Aggregate**: Registry
- **トリガー**: `reconcile()`（三層を正準IDで結合）
- **プロパティ**:
  - `unifiedRef`: string — unified.json の参照
  - `concepts`: UnifiedConcept[] — 状態付き概念
  - `occurredOn`: Timestamp
- **Consumer**: Verification
- **Enrichment/Query-Back**: Query-Back（Verification が unified を読みに行く）

### Verification（検証＋裁定）

#### FindingProduced
- **発生元 Aggregate**: Finding
- **トリガー**: `produce(discrepancy, runId)`
- **プロパティ**:
  - `findingId`: string
  - `discrepancy`: Discrepancy — category/severity/expected/actual/evidence
  - `occurredOn`: Timestamp
- **Consumer**: Convergence
- **Enrichment/Query-Back**: Enrichment

#### VerdictReached
- **発生元 Aggregate**: Finding
- **トリガー**: `adjudicate(votes)`（反証3レンズ）
- **プロパティ**:
  - `findingId`: string
  - `verdict`: Verdict — classification(bug/unnecessary/uncertain)・confidence
  - `occurredOn`: Timestamp
- **Consumer**: Reporting
- **Enrichment/Query-Back**: Enrichment

### Convergence（収束）

#### KnownStateUpdated
- **発生元 Aggregate**: KnownFinding
- **トリガー**: `record(fingerprint, reason, by)`（feedback 焼き込み）
- **プロパティ**:
  - `fingerprint`: string — 既知化キー
  - `occurredOn`: Timestamp
- **Consumer**: Verification
- **Enrichment/Query-Back**: Query-Back（次回 run で既知を読み抑制）

### Scenario Lifecycle（シナリオ育成）

#### ScenarioApproved
- **発生元 Aggregate**: Scenario
- **トリガー**: `approve()`
- **プロパティ**:
  - `scenarioId`: string
  - `occurredOn`: Timestamp
- **Consumer**: Verification
- **Enrichment/Query-Back**: Query-Back

### Reporting（報告）

#### ReportGenerated
- **発生元 Aggregate**: Report
- **トリガー**: `generate()`（Finding/Verdict 集約）
- **プロパティ**:
  - `runId`: string
  - `summary`: string — bug/uncertain/unnecessary 集計
  - `occurredOn`: Timestamp
- **Consumer**: Reporting
- **Enrichment/Query-Back**: Enrichment

## Event Flow (コンテキスト間)

Observation --{BehaviorEmitted}--> Reconciliation
  → Reconciliation が三層を正準IDで結合
Reconciliation --{UnifiedGenerated}--> Verification
  → Verification が unified を「期待」に検証
Scenario Lifecycle --{ScenarioApproved}--> Verification
  → 採用シナリオが検証ケースになる
Verification --{FindingProduced}--> Convergence
  → 既知化の判定対象になる
Verification --{VerdictReached}--> Reporting
  → レポート・GitHub issue に集約
Convergence --{KnownStateUpdated}--> Verification
  → 次回 run で既知 Finding を抑制

## Event Sourcing 対象
- Finding: 不採用 — verdict は votes から都度導出（再現可能）。Run 単位で再生成。
- KnownFinding: 採用寄り — burn-in は追記イベントの蓄積（人の判断の履歴）。

## 未解決の問い
- `BehaviorEmitted` の単位（ページ単位 LayerNode で十分か、scenario 実行結果も emit するか）。
- `UnifiedGenerated` を真の非同期 Domain Event にするか（現状はファイル受け渡し）。
