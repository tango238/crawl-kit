# ADR-0006: ADR 層を初日から契約スキーマに入れる

- **status**: accepted
- **date**: 2026-06-27
- **affects**: （全 concept）

## Context
intent↔structure のずれは、欠陥なのか・意図が進んでモデルが古いだけなのか区別できない。
ADR(時間・因果の層)があれば裁定できる。ADR を後付けオーバーレイにすると、導入時にスキーマ
移行が要る。

## Decision
ADR 層を最初から contract スキーマに彫る。`Adr` は**独立レコード**(`affects: ConceptId[]`)、
concept は `decisions: AdrId[]` を持つ(多対多)。中身は**空配列スタート**でよい。

## Consequences
- 概念が初日から「裁定済み」状態を持てる。後付け移行がゼロ。
- 状態に `adjudicated` / `violates-decision` を最初から置ける。
- 初期のスキーマがやや重くなるが、空で在るだけなので運用負荷は無い。

## Alternatives considered
- ADR を後付けオーバーレイ: 早く動くが導入時にスキーマ移行が必要。ユーザーは「空白でよいなら
  初日から入れたい」と判断。退けた。
