# ADR-0002: distill-ddd はコード統合せず契約のみ接続

- **status**: accepted
- **date**: 2026-06-27
- **affects**: （intent 層全般）

## Context
distill-ddd は実行するプログラムではなく、CLI エージェント(Claude Code / Codex / Gemini)の
ホームに住み、人と対話する**スキル**。コードは installer のみ。

## Decision
distill-ddd を monorepo に**コード統合しない**。つながるのは出力(glossary)だけ。glossary は
intent 層を供給し、**正準 ID(canonicalName)の発生源**になる。

## Consequences
- スキルは独立して `~/.claude/skills/` 等にインストールされ、壊れない。
- glossary を contract に流すための小作業が要る: `docs/domain/*.md`(散文)→ `glossary.json`。
  発生源で emit するか(きれい)、reconciler でパースするか(早い)は intent 辺着手時に決める。
- 統合の地図が三者三様に確定: loop-e2e=吸収、rdra=port、distill-ddd=参照。

## Alternatives considered
- packages/ に引き込む: スキルとして浮くだけで意味を持たない。退けた。
