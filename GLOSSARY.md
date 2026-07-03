# GLOSSARY

このプロジェクト自身のユビキタス言語。スイートの核心が「同じモノを同じ名前で指す」ことなので、
プロジェクト自身も用語を一つに固定する。

## 三層

- **intent(意図)** — こう作りたい、という規範的なモデル。distill-ddd 由来。should-be。
- **structure(構造)** — こう作った、という静的なモデル。rdra-analyzer 由来。as-built。
- **behavior(挙動)** — こう動いている、という実行時の事実。loop-e2e 由来。as-run。
- **layer(層)** — 上の三つの総称。

## 概念とレジストリ

- **concept(概念)** — ドメイン上の一つのモノ。正準 ID(`concept:order`)と正準名を持つ。
- **canonical name(正準名)** — その概念の唯一の名。glossary(intent)が発行する。
- **ubiquitous language(ユビキタス言語)** — 業務とコードで共有される語彙。正準名の源泉。
- **registry(レジストリ)** — 永続。concepts + adrs + relations。人の判断の蓄積。`registry.json`。
- **unified** — 派生・使い捨て。三層を解決した概念行の集合。viewer が読む。`unified.json`。
- **LayerNode** — 各ツールが出した層ローカルの成果物。reconciler が concept に結ぶ。

## reconciliation(突き合わせ)

- **reconciler** — 層のノードを食べ、同一性を判定し、状態を分類し、ADR で裁定し、unified を吐く層。
- **match(マッチ)** — 「これとこれは同じ概念か」の判定。reconciliation の本体。
- **evidence(証拠)** — マッチの根拠。`name / attributes / topology / behavior / llm` のベクトル。
  単一スコアにはしない。
- **direction(方向)** — 自動で寄せる向き。intent 優先(トップダウン)か code 優先(ボトムアップ)か。
- **threshold(閾値)** — これ以上なら自動、未満なら手作業キュー。
- **manual queue(手作業キュー)** — 閾値未満の曖昧なマッチを人が裁く列。判断はレジストリに焼き込む。

## 状態(ConceptState — 色の凡例)

- **aligned** — 在るべき層に在り整合。
- **intent-only** — 設計済み・未実装。
- **code-only** — コードに在り意図に無い(漏れ or 詳細)。
- **aggregate-internal** — 孤児ではなく、マッチ済み集約の境界内。
- **implementation-detail** — ドメイン線の下として受容(中間表・session・outbox 等)。
- **adjudicated** — ずれているが ADR が説明(モデルが追従中)。
- **violates-decision** — ずれていて、かつ ADR の制約を破る。最重要。
- **unmatched** — 未分類。

## 関係(Relation)

- **same-as** — 層をまたぐ同一性。Evidence を持つ。
- **part-of** — 集約の境界内に属する。aggregate-internal の根拠。
- **serves** — 技術概念がドメイン概念に奉仕する(outbox → events)。
- **derived-from** — 読み取りモデル/射影が source 概念から派生する。
- **below the line(線の下)** — ドメインが気にしない実装詳細の領域。

## ADR

- **ADR(意思決定記録)** — 設計判断の時間・因果の記録。辺の上に乗る裁定者。独立レコード。
- **affects** — その ADR が効く concept 群。
- **constraint(制約)** — ADR が課す機械照合可能な規則(`forbid-dependency` 等)。
- **adjudicate(裁定)** — ずれが欠陥か・追従遅れか・違反かを ADR で決めること。

## 差分

- **edge(辺)** — 二層の間の比較。`intent↔structure` / `structure↔behavior` / `intent↔behavior`。
- **divergence(差分)** — 辺の上の食い違い。viewer で色づく対象。
- **route key** — URL/エンドポイントの正規化キー。structure↔behavior の強いマッチ鍵。
