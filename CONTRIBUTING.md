# CONTRIBUTING

開発環境・規約・移植の指針。

## 前提

- **Node 20+**
- **pnpm**(workspace を使う)
- LLM バックエンド(下記)のいずれか

## セットアップ

```bash
pnpm install
pnpm -r build      # 全パッケージをビルド
pnpm -r test       # テスト
pnpm -r lint
```

## workspace

`pnpm-workspace.yaml` が `packages/*` と `skills/*` を宣言する。パッケージ間依存は
`@crawl-kit/*` で参照する。**全パッケージが `@crawl-kit/contract` に依存してよいが、
contract は何にも依存しない**(背骨は葉であるべき)。

```
packages/contract     # 依存: なし
packages/reconciler   # 依存: contract (+ llm)
packages/structure    # 依存: contract (+ llm)
packages/behavior     # 依存: contract (+ llm)
packages/viewer       # 依存: contract のみ（型だけ。実行時は unified.json を読む）
packages/llm          # 依存: なし
```

## パッケージの追加

1. `packages/<name>/` に `package.json`(name は `@crawl-kit/<name>`)と `tsconfig.json`
   (`tsconfig.base.json` を extends)。
2. contract に依存するなら `dependencies` に `@crawl-kit/contract: "workspace:*"`。
3. 公開 API は `src/index.ts` から export。

## LLM バックエンド

rdra も loop-e2e も「`USE_CLAUDE_CODE` で Anthropic API ↔ Claude Code CLI を切替」を持っていた。
同じ規約を踏襲する:

```bash
# 既定: Anthropic API（CI/本番向け）
ANTHROPIC_API_KEY=sk-ant-...

# ローカル: Claude Code CLI（API キー不要）
USE_CLAUDE_CODE=true   # 真値: 1 / true / yes（大文字小文字無視）
```

将来 `packages/llm` に一本化する(ROADMAP v2)。それまでは各パッケージ内で同じ環境変数を読む。

## rdra の移植(Python → TS)指針

`packages/structure` は rdra-analyzer の **静的抽出コアのみ** を移植する。来ないもの:
`scenarios`/`e2e` → behavior、`verify` → reconciler、`viewer` → viewer。

移植対象と元ファイルの対応は [STRUCTURE.md](./STRUCTURE.md) の `packages/structure` 節を参照。
方針:

- LLM 駆動の解析ロジック(プロンプト)は挙動を変えずに移す。プロンプト文言は据え置きが安全。
- `CLAUDE.md`/`AGENTS.md` をコンテキストに使う仕組みはそのまま踏襲。
- 出力は最終的に **`emit.ts` で contract の `LayerNode` に変換**する。route key を必ず付ける
  (structure↔behavior マッチの鍵)。

## loop-e2e の吸収

すでに TS。`packages/behavior` へ移し、**`rdra-export` を削除**して `emit.ts`(contract への出力)に
置き換える。クロール/シナリオ/E2E/検証は behavior が所有し続ける(分割しない)。

## ADR プロセス

横断的・不可逆な判断をしたら **ADR を一つ起こす**。このプロジェクト自身が ADR を実践する
(ツールの核心機能なので)。テンプレートとこれまでの判断は [docs/adr/](./docs/adr/)。

- ファイル名: `docs/adr/NNNN-kebab-title.md`(連番)。
- status は `proposed` で出し、合意で `accepted` に。覆す時は新 ADR を起こし旧を `superseded`。

## コミット / PR

- 1 PR = 1 関心事。M(マイルストーン)に紐づける。
- 契約(`packages/contract`)を変える PR は、影響する全 consumer の追従を同じ PR に含める
  (monorepo を選んだ理由がこれ。原子的更新)。
- スキーマ変更は [docs/DATA-MODEL.md](./docs/DATA-MODEL.md) も同時更新。

## テストの当て所

- `contract/validate.ts`: dangling ID・型不整合で確実に落ちること。
- `reconciler/match`: 決定的シグナルが LLM より先に効くこと、Evidence が単一スコアでないこと。
- `reconciler/classify`: 「孤児の前に `part-of` を見る」順序(aggregate-internal が code-only より
  優先)。
- `reconciler/adr`: 制約違反が `violates-decision` に、決定済みのずれが `adjudicated` に。
