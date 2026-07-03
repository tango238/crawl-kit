# ADR-0003: rdra は構造専任(静的抽出のみ)

- **status**: accepted
- **date**: 2026-06-27
- **affects**: （structure 層全般）

## Context
rdra-analyzer は analyze / verify / scenarios / rdra / viewer / gap / e2e を持つ。一方
loop-e2e も crawl / scenario / e2e を持ち、両者が機能的に重複していた(`rdra-export` が
その境界を後付けで縫合していた)。役割を intent/structure/behavior に切ると、クロール・
シナリオ・E2E は挙動(behavior)の仕事。

## Decision
packages/structure には rdra の**静的抽出コアのみ**を port する: analyze(情報モデル/ユース
ケース/画面仕様) / rdra(図) / gap(CRUD)。`scenarios`・`e2e` は behavior へ、`verify` は
reconciler へ(ADR-0005)、`viewer` は新 viewer へ。

## Consequences
- 「rdra=構造 / loop-e2e=挙動」の縄張りがコードレベルで確定し、「何のために使うのか」が
  曖昧でなくなる。
- rdra↔loop-e2e のクロール重複が消える(→ ADR-0004)。

## Alternatives considered
- rdra にクロールを残す: behavior と重複し続け、`rdra-export` 的な縫合が残る。退けた。
