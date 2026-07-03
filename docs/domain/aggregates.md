# Aggregates

> 由来: [event-storming.md](./event-storming.md) / [bounded-contexts.md](./bounded-contexts.md)。
> Core=Verification（検証＋裁定）を中心に、4ルール（不変条件を境界内 / 小さく / 他集約は ID 参照 / 結果整合）で右サイズ化。
> **実装は OO メソッドでなく「型＋純関数」**（loop-e2e/crawl-kit の関数型方針）。集約＝整合性境界、公開操作＝パイプライン関数。

## Right-Sizing の判断

| 候補 | 判断 | 理由（ルール） |
|---|---|---|
| Finding ＋ Verdict | **同一集約** | 検証と裁定を1 BC に統合（contexts 決定）。verdict は votes と**即時整合**が必要（R1） |
| Run と Finding | **分離** | 1 Run に多数 Finding、Finding は独自ライフサイクル（産出→裁定→既知化）。R2 小さく / R3 RunId 参照 |
| Finding と KnownFinding | **分離** | Convergence BC。抑制は次回 run で読む＝**結果整合**（R4） |
| Scenario | **分離** | Scenario Lifecycle BC。proposed/active の独自ライフサイクル |

## 集約一覧

### VerificationRun（BC: Verification）
- **Root / ID**: `VerificationRun` / `RunId`
- **構成**: `UnifiedRef`(VO: 期待スナップショットの参照), `TargetRef`(VO), 実行ステータス
- **不変条件**: Run は**ちょうど1つの Unified スナップショット**を「期待」として参照する（検証の基準を固定）
- **操作**:
  - `startRun(unifiedRef, target)`: 検証開始 → 発行: `RunStarted`
  - `completeRun()`: 完了 → 発行: `RunCompleted`
- **状態**: Running（初期）, Completed
- **状態遷移**:
  - ∅ → Running : `startRun(unifiedRef, target)` → `RunStarted`
  - Running → Completed : `completeRun()` → `RunCompleted`
- **他集約参照**: `UnifiedRef`(Reconciliation の Unified を ID 参照), Finding は RunId で逆参照
- **整合性**: 即時=自身のステータス／結果整合=Finding（Domain Event で産出）

### Finding（BC: Verification）★検証の原子単位
- **Root / ID**: `Finding` / `FindingId`（＋ `Fingerprint` VO = 既知化の同一性キー）
- **構成**:
  - `Discrepancy`(VO): kind(diff/verify)・category(6種)・severity・expected・actual・evidence
  - `Verdict`(内包): `RefuterVote[]`(3レンズ: correctness/security/intentionality)・classification(bug/unnecessary/uncertain)・confidence・confirmedCount/panelSize
- **不変条件**（R1: votes と verdict を同一境界で守る）:
  - `verdict.classification` は `votes` から導出（多数決: confirmedCount ≥ 過半 → bug）。**votes 無しに classification を立てられない**
  - `confidence ∈ [0,1]`、`confirmedCount ≤ panelSize`
  - `RunId` を必ず持つ（R3: 親 Run を ID 参照）
- **操作**:
  - `produce(discrepancy, runId)`: 食い違いを Finding 化 → 発行: `FindingProduced`
  - `adjudicate(votes)`: 反証パネルで裁定 → 発行: `VerdictReached`
- **状態**: Produced（初期）, Adjudicated
- **状態遷移**:
  - ∅ → Produced : `produce(discrepancy, runId)` → `FindingProduced`
  - Produced → Adjudicated : `adjudicate(votes)` → `VerdictReached`
- **他集約参照**: `RunId`、必要なら `ConceptId`(unified の概念) を ID 参照
- **整合性**: 即時=Discrepancy＋Verdict（同一集約）／結果整合=KnownFinding（Fingerprint で抑制）

### Boundary（BC: Verification）★system 境界軸 = 本丸の検証
- **Root / ID**: `Boundary` / route キー（例 `POST /orders`）。VerificationRun の下位の**検証単位**。
- **構成（triple）**: ひとつの境界が3 facet を持つ — **Input**（入力項目）/ **Display**（表示項目）/ **Persistence**（保存）。
- **期待（structure＝as-built）**: Input=`ParsedPage.formFields`／Display=entity 属性／Persistence=`Usecase.crud`＋`EntityOperation`＋entity 列。
- **観測（behavior＝as-run）**: Input=`PageInfo.inputItems`／Display=`PageInfo.displayItems`／Persistence=`dbProbe.wasValueSaved`（registeredData）。
- **照合（intent 不要・structure↔behavior だけで完結＝Core）**: route→entity→concept の reconcile 結合を土台に、facet ごとに期待 vs 観測を突き合わせる。
- **findings（粒度＝境界×facet）**:
  - `input-undeclared` / `input-missing`（実行時入力と宣言入力の差）
  - `display-unbacked`（表示が entity 属性に裏付け無し）
  - `not-persisted`★（C/U 境界なのに保存が観測されない＝入れたのに残らない）/ `persistence-unobserved`（未観測・失敗ではない）
  - `roundtrip-ok`（入力→保存→再表示が通る＝最強の合格）
- **note**: event 軸（intent 起点）は前段。**境界軸（structure 起点）が behavior conformance を直接測る Core**。

### Scenario（BC: Scenario Lifecycle）
- **Root / ID**: `Scenario` / `ScenarioId`
- **構成**: `Step[]`(VO: action/target/value/expect), `status`(proposed/active), `Coverage`(VO)
- **不変条件**: `active` は approve 済み、`steps` 非空
- **操作**:
  - `propose()`: 草案を出す → 発行: `ScenariosProposed`
  - `approve()`: active へ昇格 → 発行: `ScenarioApproved`
- **状態**: proposed（初期）, active
- **状態遷移**:
  - ∅ → proposed : `propose()` → `ScenariosProposed`
  - proposed → active : `approve()` → `ScenarioApproved`
- **整合性**: 即時=自身

### KnownFinding（BC: Convergence）
- **Root / ID**: `KnownFinding` / `Fingerprint`
- **構成**: `reason`, `by`, `recordedAt`
- **不変条件**: 同一 `Fingerprint` の Finding を抑制する（既知＝再浮上しない）
- **操作**:
  - `record(fingerprint, reason, by)`: 既知化を焼き込む → 発行: `KnownStateUpdated`
- **状態**: Known（単一・再浮上なし）
- **状態遷移**:
  - ∅ → Known : `record(fingerprint, reason, by)` → `KnownStateUpdated`
- **他集約参照**: Finding を `Fingerprint` で参照（R3）
- **整合性**: 結果整合（Verification が次回 run で読む。R4）

### Feedback（BC: Convergence）
- **Root / ID**: `Feedback` / `FeedbackId`
- **構成**: `targetFindingId`(ID参照), `userComment`, `verdict`(valid/invalid), `appliedTo`(ScenarioId[])
- **操作**:
  - `submit()`: 指摘を提出 → 発行: `FeedbackSubmitted`
  - `verify()`: valid/invalid を判定 → 発行: `FeedbackVerified`
- **状態**: Submitted（初期）, Verified
- **状態遷移**:
  - ∅ → Submitted : `submit()` → `FeedbackSubmitted`
  - Submitted → Verified : `verify()` → `FeedbackVerified`
- **他集約参照**: `FindingId` / `ScenarioId`（R3）

### SiteStructure（BC: Observation）
- **Root / ID**: `SiteStructure` / `(runId, generatedAt)`
- **構成**: `PageInfo[]`(VO: url/title/displayItems/inputItems/expectations/capabilities), `Transition[]`(VO)
- **不変条件**: 各 Page は URL を持つ
- **操作**:
  - `capture(crawl)`: クロールして収集 → 発行: `AppCrawled`
  - `extract(llm)`: ページを構造化 → 発行: `SiteStructureExtracted`
- **状態**: Captured（初期）, Extracted
- **状態遷移**:
  - ∅ → Captured : `capture(crawl)` → `AppCrawled`
  - Captured → Extracted : `extract(llm)` → `SiteStructureExtracted`
- **整合性**: 即時=自身（observe のみ。判定はしない）

### Concept / Registry（BC: Reconciliation）※既存 contract
- **Root / ID**: `Concept` / `ConceptId`、整合境界の親=`Registry`
- **構成**: aliases, kind, nodes(層→NodeId[]), `ConceptState`, decisions(AdrId[]), resolution
- **不変条件**: 参照整合（dangling な ConceptId/AdrId 禁止）。`Registry` 書込はゲートを通る
- **note**: ここの `Verdict 相当 = ConceptState`（「同一概念か」）。Verification の Verdict（「バグか」）とは別概念（別 BC）
- **状態**: intent-only（初期・intent由来）, aligned, unmatched（初期・code由来）, aggregate-internal, implementation-detail, code-only, adjudicated, violates-decision
- **状態遷移**: （コード由来＝classify.ts / pipeline.ts / adr.ts の分類ロジックを intent として明文化。reconcile が判定するので発行イベントは持たない）
  - ∅ → intent-only : `reconcile()`  （intent concept を seed・構造未マッチ）
  - intent-only → aligned : `attach()`  （構造エンティティが same-as でマッチ＝auto/human）
  - ∅ → unmatched : `classifyUnmatched()`  （未マッチ構造が曖昧・人手キュー行き）
  - ∅ → aggregate-internal : `classifyUnmatched()`  （未マッチだが matched aggregate root に依存＝part-of）
  - ∅ → implementation-detail : `classifyUnmatched()`  （未マッチかつ below-the-line 名：sessions/outbox/audit…）
  - ∅ → code-only : `classifyUnmatched()`  （未マッチ・part-of でない・below-line でない＝真のリーク）
  - code-only → adjudicated : `applyAdr()`  （受理 ADR の note が divergence を説明）
  - aligned → violates-decision : `applyAdr()`  （構造依存が受理 ADR の forbid/require に違反）

## Anemic チェック（--analyze 観察）

移植した loop-e2e は **関数型**（`domain/types.ts` の型＋pipeline の純関数）で、OO のメソッド付き集約ではない。
これは「貧血ドメイン」ではなく**意図的な関数型設計**（DMMF）。集約の「公開操作」は pipeline 関数として実現される（types フェーズで `Result<Ok,Err>` 型として固める）。

## 未解決の問い

- `Finding` の `Verdict` を内包（即時整合）で確定だが、**反証 votes の取得は LLM 非同期**。集約には「裁定済み votes」を渡し、取得自体は外側（関数引数）に置く（R: 依存は引数渡し）。
- `Fingerprint` の算出規則（何で同一とみなすか）— category＋location＋正規化シグネチャ？ events/types で固める。
- Reconciliation と Convergence の burn-in を共有 VO（`BurnIn<Decision>`）にするか（語彙は別のまま）。
