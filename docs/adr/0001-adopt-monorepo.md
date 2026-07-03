# ADR-0001: monorepo(B案)を採用する

- **status**: accepted
- **date**: 2026-06-27
- **affects**: （なし）

## Context
三ツール(loop-e2e / rdra-analyzer / distill-ddd)の出力を一箇所で突き合わせたい。
コードの所在(リポジトリ構成)と、データの収束点は別問題。収束点(reconciler+viewer)は
リポジトリ構成を要求しないが、契約スキーマ(registry/unified)は初期に頻繁に揺れる見込み。

選択肢:
- A(軽量): 契約+reconciler+viewer を1リポジトリ、三ツールは別。
- B(全部入り): 現実的には distill-ddd を除く monorepo。

## Decision
B(monorepo)を採用する。ただし「三ツールの書き直し」ではなく、契約+reconciler+viewer を
greenfield TS で建て、loop-e2e を吸収、rdra を port、distill-ddd は契約のみ接続する形。

## Consequences
- 契約スキーマの変更が原子的に全 consumer へ波及できる(初期の揺れに強い)。
- TS への一本化で polyglot 摩擦が減る(distill-ddd を除けば Python の外れ値が消える)。
- CI/リリースの整備コストを負う(v2 で対応)。

## Alternatives considered
- A(軽量): 早く動くが契約のバージョニングが要る。スキーマが固まった後に B から切り戻す道は
  残る(可逆)。当面は揺れる時期なので原子更新の価値を採った。
