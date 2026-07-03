# Model ⇔ Implementation Sync

> `--analyze`（discover/storming）で発見した差異を判定・計画・実装し、モデルとコードを一致させる台帳。
> 大きな差異 #2/#6 は**アーキテクチャ分岐**のため承認ゲートで方針を選んでから実装する。

## 差異台帳

| # | 由来 | 種別 | 権威 | 決定 | 状態 |
|---|---|---|---|---|---|
| 1 | discover | gap | model | loop-e2e 本体(9,068 LOC+562 tests)を behavior に忠実移植、rdra-export→emit 置換 | **done** |
| 2 | discover | violation | model | **`packages/verification` を新設**: unified.json を入力に Finding/Verdict を生成（名寄せでなく検証判定）。reconciler の behavior 名寄せ自体の整理は残 | **in-progress** |
| 3 | discover | misweight | model | STRUCTURE.md で reconciler=Supporting を明示（コード削除なし） | **done**(doc) |
| 4 | discover | naming | model | README/STRUCTURE 語彙是正（差分=intent↔structure、Core=検証、reconciler=Supporting） | **done**(doc) |
| 5 | storming | duplication | deferred | adjudication+burn-in は別文脈で維持（統合しない・ユーザー決定） | **deferred** |
| 6 | storming | split | model | Option B 段階分割に着手: Verification 文脈を独立パッケージで新設（unified 入力・後段）。loop-e2e の verify/explore/scenario/refute の behavior→verification 移設は残 | **in-progress** |

## 実装結果（Option B vertical slice）

- **新規 `packages/verification`**（Core・後段）: `model.ts`(Finding/Verdict/RefuterVote) ＋ `verify.ts`(reconcile 状態→Finding) ＋ `adjudicate.ts`(3レンズ反証パネル→Verdict) ＋ cli/index/test。
- **データフロー確定**: `… → reconciler → unified.json → verification → data/verification.findings.json`（root `pnpm demo` / `pnpm verify` に組込）。
- **reconcile 後段だから出せる検証を実証**: `violates-decision(Payment)` を `decision-violation/bug[adr:0010]` Finding として、`/orders/777` の 5xx を `runtime-error/bug` として生成（計 7 findings: 2 bug / 5 uncertain）。
- **検証**: 7パッケージ build green、**626 tests pass（+7 verification、後方互換維持・behavior は当面そのまま）**。
- **後方互換**: behavior(loop-e2e) は無変更で稼働。demo の behavior 入力は `data/behavior.nodes.json`（将来 `loop-e2e run + emit` が供給）。

## 残スコープ（次の赤付箋）

- loop-e2e の verify/explore/scenario/refute を behavior→verification へ**実移設**（現状は reconcile-aware の最小検証のみ）。検証の「期待」を baseline→unified に総替え。
- behavior を「観測(crawl)のみ」に縮小（#2 の完了）。reconciler の behavior 名寄せを verdict 受け渡しへ整理。
- demo の behavior 入力を `loop-e2e run + emit` に正式配線（現状は demo 用 `behavior.nodes.json`）。

## 差異の詳細と計画

### #4 naming（低リスク・doc のみ・即実装可）
- **発見**: README「差分」/ docs「心臓=reconciler」が discovery（Core=検証）と食い違う。
- **権威**: model。**計画**: README/STRUCTURE/ARCHITECTURE の語彙を是正（差分=intent↔structure 限定、Core=検証）。
- **影響**: ドキュメントのみ。コード・テストに影響なし。スコープ外: 既存の `unified.json` の `divergences` フィールド名は据え置き（破壊回避）。

### #3 misweight（低リスク・doc 主体）
- **発見**: reconciler の intent 辺が厚い(478 LOC)が、intent 非所有ゆえ Supporting。
- **権威**: model。**計画**: docs と package 説明で「reconciler=Supporting（名寄せ土台）」を明示。**コード削除はしない**（intent 接続時に活きる）。

### #2 / #6 アーキテクチャ分岐（高リスク・要承認）
- **発見**: 忠実移植は loop-e2e 全機能を behavior に格納。モデルは「観測(behavior) / 検証(後段の独立 Verification)」分割を要求。
- **コードの事実**:
  - behavior は `pipeline/{collect,diff,verify,explore,executeScenarios,grow,report}` ＋ `services/{browser,llm,explore}` ＋ state/scenario/config/cli を一体で持つ。
  - 検証の「期待」は現状 **baseline(SiteStructure)**。モデルは **unified.json(reconcile結果)** を期待にせよと要求 → **パイプライン最深部の入力差し替え**が要る。
  - 562 tests がこの一体構造に紐づく。分割は再ホーム＋配線替えを伴う。
- **権威**: model（分割が正）。だが**コストとリスクが大きい**ため方針を選ぶ。

#### 方針分岐（承認ゲート）

| 案 | 内容 | コスト/リスク |
|---|---|---|
| **A. 一括分割** | 即 `packages/verification` を作り verify/explore/scenario/refute/report/state(findings,known) を移設、入力を baseline→unified に総替え | 高（9k LOC 再ホーム・562 tests 配線替え・diff にノイズ）。一気に緑にするのは困難 |
| **B. 段階分割（vertical slice・推奨）** | ①#3/#4 の doc 是正を先に → ②`packages/verification` の骨組み（unified.json を読み Finding/Verdict を emit する最小経路＋1カテゴリ）を**新規追加** → ③behavior の verify を段階移設。各段で緑を保つ | 中（段階的・後方互換維持）。behavior は当面そのまま動く |
| **C. モデル先行（実装は据え置き）** | コードは現状維持（loop-e2e in behavior）。sync.md に目標アーキを記録し #2/#6 を planned のまま据え置き | 低（doc のみ）。実装は後日 |

## スコープ外・残課題（新しい赤付箋）

- 検証の「期待」に intent をどこまで使うか（intent 非所有 → 最小依存）。
- Fingerprint 算出規則の確定（events/types）。
- burn-in（Reconciliation / Convergence）の共有 VO 化是非。

## 未解決の問い

- #2/#6 をどの案で進めるか（A/B/C）。
