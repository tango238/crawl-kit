# Context Map

> 由来: [bounded-contexts.md](./bounded-contexts.md)（8 BC、Verification=Core 後段、Adjudication 統合済み）。
> **統合の基盤は共有の背骨（Spine/Contract）上のファイル受け渡し ＝ Published Language**。
> 各文脈は直接呼び出さず、`data/*.json`（versioned・validated）を emit/read して疎結合に連携する。

<!-- ddd:diagram:context-map -->

## 関係一覧

| Upstream | Downstream | 関係 | 統合方式（PL on Spine） | 備考 |
|---|---|---|---|---|
| **Spine/Contract** | 全文脈 | Published Language ＋ Shared Kernel | 型 ＋ atomic validated I/O | `LayerNode/Registry/Unified`、参照整合ゲート |
| Intent(外部) | Reconciliation | **Customer-Supplier ＋ ACL** | `intent.nodes.json` | distill-ddd 非所有 → `intent emit` が ACL（翻訳層） |
| Structure Extraction | Reconciliation | Customer-Supplier | `structure.nodes.json` | as-built、PL=LayerNode |
| Observation | Reconciliation | Customer-Supplier | `behavior.nodes.json` | as-run、PL=LayerNode |
| **Reconciliation** | **Verification** | **Customer-Supplier** | `unified.json` ＋ `registry` | ★検証の「期待」を供給する後段の核心線 |
| Scenario Lifecycle | Verification | Customer-Supplier | active scenarios | 検証ケースを供給 |
| Convergence | Verification | **Partnership / Shared Kernel** | `known-findings`（双方向） | finding 抑制（既知化）。同一チーム・finding ライフサイクル共有 |
| Verification | Reporting | Customer-Supplier | findings/verdicts | GitHub issue 化（Generic 下流） |
| Verification | Spine | Published Language | emit（verdict/finding ノード） | viewer 表示用。**TBD: 何を背骨に戻すか** |
| Reconciliation | Convergence | Separate Ways（現状） | — | burn-in 二系統。Shared Kernel 化は未決 |

## 統合の詳細

### Reconciliation → Verification（核心）
- **関係**: Customer-Supplier（U=Reconciliation）。両者 crawl-kit 所有なので上流は下流の要望に応える。
- **流れるデータ**: `UnifiedGenerated`（`unified.json` ＋ `registry`）。三層が正準IDで結合済み。
- **統合方式**: 背骨上のファイル（将来は `UnifiedGenerated` Domain Event の非同期メッセージ化が推奨）。
- **ACL**: 不要（共有 Published Language `Unified` に準拠）。

### Intent(外部) → Reconciliation（ACL が要る唯一の境界）
- **関係**: Customer-Supplier だが Intent は**非所有・変更不可**。downstream を守るため **ACL** を置く。
- **ACL の実体**: `packages/intent` の `emit`（distill-ddd の散文/glossary → 契約 `LayerNode` へ翻訳）。
- distill-ddd 側のスキーマ変更から Reconciliation を隔離する。

### Verification ↔ Convergence（既知化の双方向）
- **関係**: Partnership（または KnownFinding/Fingerprint を共有する Shared Kernel）。
- Verification → feedback → Convergence が known-state に焼き込み → 次回 Verification が既知 finding を抑制。
- finding のライフサイクルを共有するため密結合。1 BC への再統合も将来検討余地（今は分離）。

## 統合方式の方針

- **現状**: 背骨上の **versioned JSON ファイル**（疎結合・再現可能・オフライン）。これが crawl-kit の「ひとつの背骨」の実体。
- **将来**: 各 emit を **Domain Event**（`BehaviorEmitted` / `UnifiedGenerated` / `FindingProduced` / `KnownStateUpdated`）として非同期メッセージ化（DDD Distilled 推奨）。Published Language は既に契約として確立済みなので移行は段階的。

## 未解決の問い

- **Verification → Spine に何を戻すか**（verdict/finding を LayerNode として背骨に emit し viewer で見せるか、別系統か）。
- **Reconciliation と Convergence の burn-in を Shared Kernel 化するか**（語彙は別のまま、焼き込み機構だけ共有）。
- 検証の「期待」に intent をどこまで使うか（intent 非所有 → 最小依存に留めるか）。
