# Event Storming

> Core Domain = **検証（Verification）**（[discovery.md](./discovery.md)）。
> 本モデルは **移植済みの loop-e2e 実装（packages/behavior）から抽出**した（`--analyze`）。
> イベントは「検証ループ」の時系列。

## イベントフロー（コンテキスト間）

<!-- ddd:diagram:event-flow -->
（[domain-events.md](./domain-events.md) の Event Flow から自動描画。観測→照合→検証→報告／収束の連鎖。）

## Domain Events（時系列）

### 検証ループ（run）

1. **ProjectInitialized** — 対象を loop-e2e 用に初期化（init）
2. **AppCrawled** — 対象アプリをクロールしページ収集（collect / Playwright）
3. **SiteStructureExtracted** — LLM がページを構造化（PageInfo: 表示項目・入力項目・期待・能力）
4. **BaselineEstablished** — 初回は SiteStructure をベースライン保存
5. **DiffDetected** — 現状 vs ベースラインの差（DiffFinding: transition/displayItem/inputItem/expectation-gap）
6. **InputExplored**（任意・explore）— 境界値・不正入力を書き込んで UI 状態を生成
7. **VerifyFindingProduced** — 6カテゴリ検証で違反検出（layout/security/access-control/conditional/registered-data/error-handling）
8. **ScenarioExecuted** — 採用シナリオを実行し期待と突き合わせ
9. **FindingRefuted / FindingConfirmed** — 反証パネル（3レンズ: correctness/security/intentionality）が各 finding を反証
10. **VerdictReached** — 多数決で分類（bug / unnecessary / uncertain）＋確信度
11. **ReportGenerated** — pending findings を集約しレポート化（＋GitHub issue）
12. **BehaviorEmitted** — 検証結果を crawl-kit の背骨へ emit（route-keyed LayerNode）★ rdra-export の置換

### 既知化ループ（feedback / 収束）

13. **FeedbackSubmitted** — 人が finding に指摘（誤検知/正しい）
14. **FeedbackVerified** — LLM が valid/invalid を判定
15. **KnownStateUpdated** — 判断を known-findings に焼き込み（次回から再浮上しない＝burn-in）

### シナリオ育成ループ（grow / approve）

16. **ScenariosProposed** — クロール＋ソース理解から新シナリオ草案（grow）
17. **ScenariosApproved** — 草案を active に昇格（approve）

## Command / Event マトリクス

| Actor | Command | Aggregate | → Event | 備考 |
|---|---|---|---|---|
| Dev | InitProject | Project/Config | ProjectInitialized | |
| Dev | RunLoop | **Run** | AppCrawled→DiffDetected→VerifyFindingProduced→ReportGenerated | 検証ループ本体 |
| System | Crawl | Crawl(Page) | AppCrawled | Playwright |
| LLM | ExtractStructure | **SiteStructure** | SiteStructureExtracted | |
| System | DetectDiff | Run | DiffDetected | baseline 比較 |
| Dev | Explore | InputExploration | InputExplored | run --explore |
| System | Verify ×6 | **Finding** | VerifyFindingProduced | 6カテゴリ |
| System | ExecuteScenarios | **Scenario** | ScenarioExecuted | |
| LLM(panel) | Refute | **Verdict** | FindingRefuted / VerdictReached | 反証ゲート（trust） |
| System | GenerateReport | **Report** | ReportGenerated | 集約・GitHub issue |
| Dev | SubmitFeedback | **Feedback** | FeedbackSubmitted / FeedbackVerified | |
| System | UpdateKnownState | **KnownFinding** | KnownStateUpdated | burn-in |
| Dev | Grow | Scenario | ScenariosProposed | |
| Dev | Approve | Scenario | ScenariosApproved | |
| Dev | Emit | BehaviorNode | BehaviorEmitted | crawl-kit 背骨へ |

## 検証の単位（discovery 未解決の問いへの回答）

コードが答えを示している。多層だが**原子的単位は Finding**:
- **Finding**（DiffFinding / VerifyFinding）＝ 一つの「想定と現実の食い違い」。**verdict を持つ最小単位**。
- **Run** ＝ 検証ループ一回。**Scenario** ＝ 検証ケース。**Report** ＝ Finding 集約。
- → 「検証の単位は？」は **Finding（verdict 付き）** が核。Scenario/Run はその器。

## 発見された問題点（赤付箋）

- 🔴 **二重の adjudication+burn-in が並存**：loop-e2e は `Verdict + RefuterVote + KnownFinding/Feedback`、
  crawl-kit reconciler は `ConceptState + Evidence + decisions/corrections`。**同じ『候補を証拠で裁定し、人の判断を焼き込む』構造が2文脈に重複**。語彙統一 or 共有が要る（contexts フェーズの論点）。
- 🔴 **behavior を reconciler が対等レンズとして名寄せ**（discovery divergence #2）。本来 behavior は
  「期待（structure）に対する検証判定」を出すべきで、route 概念として code-only/unmatched 分類するのは誤り。
- 🟡 **emit の Finding↔Page 紐付けが暫定**（URL 部分一致）。VerifyFinding に route/page 参照が薄い。

## アーキテクチャ決定：Verification を reconciliation の後段へ（確定方針）

Adjudication/Verification は reconciler の同一性裁定とは**別文脈のまま**。ただし **behavior の外に出し、
reconciliation の後段に挟む**。behavior は「観測(crawl)」に縮小する。

```
intent ─┐
structure ─┤→ reconciliation(正準IDで三層結合 → unified) → Verification(独立・後段)
behavior(観測) ─┘                                              │ 入力: unified + 実行中アプリ
                                                              ▼ Finding/Verdict
```

**後段化で開く検証（reconcile 済みの三層関係を「期待」にできる）:**
- intent↔behavior 適合（業務が欲しかった通り動くか）— reconcile が intent↔behavior を結んで初めて可能
- violates-decision の実地検証（structure×ADR の計算違反が実行時に顕在化するか）
- intent-only（設計済み未実装）の不在検証
- 集約境界(part-of)に沿ったシナリオ構成

→ loop-e2e の baseline-diff（structure 単体の期待）から、**reconcile 済み三層を期待とする検証**へ射程拡大。

**含意（divergence #6）**: 忠実移植は全機能を behavior に入れたが、本決定は
**crawl(観測)＝behavior / verify・explore・scenario・refute・report＝後段 Verification 文脈** への分割を要求。

## Bounded Context 候補（contexts フェーズへの橋渡し）

- **Crawl & Structure**（collect ＋ LLM 構造化）
- **Verification**（diff ＋ verify6 ＋ explore ＋ scenario 実行）← Core
- **Adjudication**（反証パネル → Verdict）＝ trust ゲート
- **Reporting**（集約 ＋ GitHub issue）
- **Convergence / Known-state**（feedback → known-findings の burn-in）
- **Scenario Lifecycle**（grow → approve）
- **Spine Emit**（crawl-kit 背骨への境界）

## 未解決の問い

- Adjudication（loop-e2e 反証ゲート）と reconciler の同一性裁定は**統合すべき1文脈か、別文脈か**。
- behavior の検証結果は reconciler に「判定」としてどう渡すか（名寄せでなく verdict として）。
- 検証の「期待」の出所：structure だけか、intent（distill-ddd）接続でどの検証が強くなるか。
