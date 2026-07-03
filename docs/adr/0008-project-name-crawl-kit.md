# ADR-0008: プロジェクト名を crawl-kit に確定する

- **status**: accepted
- **date**: 2026-06-27
- **affects**: （なし）

## Context
スイートの作業名は Triangulate(仮)で、パッケージ scope も `@triangulate/*` の仮置きだった。
他人への展開には確定した名前が要る。命名はこのプロジェクトの流儀として ADR で記録する
(意思決定記録はスイートの核心機能なので、プロジェクト自身が実践する)。

## Decision
プロジェクト名を **crawl-kit** に確定する。npm パッケージ scope は **`@crawl-kit/*`**。

なお ADR-0004 で「作らない」と決めた共有クロール機構は、当初この語(crawl-kit)を作業名に
していた。混同を避けるため ADR-0004 では当該パッケージを「共有クロールパッケージ」と
説明的に呼び、crawl-kit の語はプロジェクト名としてのみ用いる。

## Consequences
- README / CONCEPT のタイトル・本文、CONTRIBUTING・STRUCTURE の scope が `@crawl-kit/*` に統一。
- ADR-0004 から crawl-kit の語を除去済み(ファイル名 `0004-no-shared-crawl-package.md`)。
- 名前は確定だが、覆す場合は新 ADR を起こし本 ADR を `superseded` にする。

## Alternatives considered
- Triangulate を継続: 三角測量の含意は設計を表すが、ユーザーが crawl-kit を選好。退けた。
