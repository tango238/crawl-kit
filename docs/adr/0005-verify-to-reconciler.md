# ADR-0005: verify は reconciler へ

- **status**: accepted
- **date**: 2026-06-27
- **affects**: （structure↔behavior の照合）

## Context
rdra の `verify` はシナリオ×画面 UI 要素の突き合わせ検証。これは単一ツール内の検証ではなく
**層をまたぐ照合**(挙動側のシナリオと構造側の画面仕様の整合)。

## Decision
`verify` を rdra からも behavior からも切り離し、reconciler に吸収する
(`reconciler/src/verify.ts`)。

## Consequences
- 層またぎの照合が reconciler に集約され、責務が一貫する。
- structure は純粋な静的抽出、behavior は純粋な実行時、と各層が単一責務を保つ。

## Alternatives considered
- behavior 側の検証として残す: 構造側の画面仕様に依存するため層をまたぎ、behavior の単一
  責務を崩す。退けた。
