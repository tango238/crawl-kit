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

`pnpm-workspace.yaml` が `packages/*` を宣言する。パッケージ間依存は
`@crawl-kit/*` で参照する。**全パッケージが `@crawl-kit/contract` に依存してよいが、
contract は何にも依存しない**(背骨は葉であるべき)。

```
packages/contract      # 依存: なし（背骨）
packages/intent        # 依存: contract
packages/structure     # 依存: contract, freshness, reconciler
packages/behavior      # 依存: contract
packages/reconciler    # 依存: contract
packages/verification  # 依存: contract
packages/freshness     # 依存: contract
packages/viewer        # 依存: contract のみ（型だけ。実行時は data/*.json を読む）
packages/cli           # 依存(bundled): 上記すべて（esbuild で 1 つの自己完結バンドルに同梱）
```

内部 `@crawl-kit/*` は**すべて `private: true`**。公開するのは CLI（`@tanago3/crawl-kit`）1つだけで、
内部パッケージはそこにバンドルされる（依存ゼロ配布）。

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

LLM クライアントは別パッケージには切り出さず、各パッケージが同じ環境変数を読む
（実体は `packages/structure/src/analyze/llm/`）。どちらも未設定ならオフラインの決定的
フォールバックで動く。同時実行数は `CLAUDE_CODE_MAX_CONCURRENCY`（既定 3）で制御。

## 元ツールの取り込み（完了済み・不変条件）

rdra-analyzer の静的抽出は `packages/structure` に、loop-e2e のクロール/シナリオ/E2E/CRUD は
`packages/behavior` に取り込み済み（各パッケージ構成は [STRUCTURE.md](./STRUCTURE.md) 参照）。
機能追加時に守る不変条件:

- `scenarios`/`e2e`/`crud` は **behavior が所有**（分割しない）。`verify` は verification、描画は viewer。
- 各層の最終出力は **`emit.ts` で contract の `LayerNode` に変換**し、**route key を必ず付ける**
  （structure↔behavior マッチの鍵）。
- `CLAUDE.md`/`AGENTS.md` をコンテキストに使う仕組みはそのまま。プロンプト文言の変更は挙動が変わるので慎重に。

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

## 公開（npm）

CLI は `@tanago3/crawl-kit` として npm に publish する。`pnpm release` が全パッケージをビルドし、
private でない CLI 1つだけを公開する（内部 `@crawl-kit/*` は private なので対象外・バンドルに同梱済み）。

```bash
pnpm release   # = pnpm -r build && pnpm -r publish --access public --no-git-checks
```

- **認証**: `~/.npmrc` の `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` と環境変数 `NPM_TOKEN`
  （granular token 推奨。2FA/OTP をバイパスできる）。**token はリポジトリに絶対に置かない**（ホームの `~/.npmrc`/`~/.zshrc` のみ）。
- **バージョン**: 公開前に `packages/cli/package.json` の `version` を上げる。
- **確認**: `npm view @tanago3/crawl-kit version` と、別ディレクトリで `npx -y @tanago3/crawl-kit@<ver> --help`。

## テストの当て所

- `contract/validate.ts`: dangling ID・型不整合で確実に落ちること。
- `reconciler/match`: 決定的シグナルが LLM より先に効くこと、Evidence が単一スコアでないこと。
- `reconciler/classify`: 「孤児の前に `part-of` を見る」順序(aggregate-internal が code-only より
  優先)。
- `reconciler/adr`: 制約違反が `violates-decision` に、決定済みのずれが `adjudicated` に。
