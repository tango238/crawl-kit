# Architecture Decision Records

横断的・不可逆な設計判断の記録。このプロジェクト自身が ADR を実践する(意思決定記録はスイートの
核心機能なので)。以下は設計対話でくだした判断の記録。

| ADR | 判断 | status |
|---|---|---|
| [0001](./0001-adopt-monorepo.md) | monorepo(B案)を採用する | accepted |
| [0002](./0002-distill-ddd-contract-only.md) | distill-ddd はコード統合せず契約のみ接続 | accepted |
| [0003](./0003-rdra-structure-only.md) | rdra は構造専任(静的抽出のみ) | accepted |
| [0004](./0004-no-shared-crawl-package.md) | 共有クロールパッケージを作らない | accepted |
| [0005](./0005-verify-to-reconciler.md) | verify は reconciler へ | accepted |
| [0006](./0006-adr-layer-in-contract.md) | ADR 層を初日から契約スキーマに入れる | accepted |
| [0007](./0007-reconciliation-direction-threshold.md) | 自動/手動を direction+threshold に畳む | accepted |
| [0008](./0008-project-name-crawl-kit.md) | プロジェクト名を crawl-kit に確定 | accepted |
| [0009](./0009-structure-corrections-overlay.md) | structure に人の指摘で差分を更新する補正オーバーレイ | accepted |

## テンプレート

```markdown
# ADR-NNNN: タイトル

- **status**: proposed | accepted | superseded | deprecated
- **date**: YYYY-MM-DD
- **affects**: concept:xxx, concept:yyy   （関係する概念。無ければ空）

## Context
何が問題で、どんな制約・前提があるか。

## Decision
何を決めたか。

## Consequences
その結果として得るもの・失うもの・後で効いてくること。

## Alternatives considered
検討して退けた案と、退けた理由。
```
