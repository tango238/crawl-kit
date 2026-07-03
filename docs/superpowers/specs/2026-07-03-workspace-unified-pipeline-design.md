# Workspace + 統合パイプライン + Viewer 4メニュー再構成 — 設計

- 日付: 2026-07-03
- ステータス: 承認済み（設計）
- 対象: crawl-kit 全体（contract / cli / intent / structure / behavior / viewer / freshness）

## 目的

既存ソースコードから **intent → structure → behavior** のリバースエンジニアリングを一気通貫で実行できるようにする。コアとなる軸は**イベント**。読み解く順番は:

1. structure のシステム境界を探す（コントローラーとルーティング = Pass1）
2. アプリケーション層・ユースケース層を頼りに（LLMで）リポジトリやモデルを探し、そのメソッドの操作（CRUD）を抽出する（UC×エンティティ相関 = Pass2/Pass3）
3. intent から事前に**集約**を作っておき、リポジトリ/モデルと集約のマッピングを作る（集約×エンティティ相関）
4. behavior はリンクだけでなく**ボタンも拾って**観測し、画面遷移時のデータ更新を DB で確認する

## 決定事項（ユーザー承認済み）

1. **ワークスペース中心に統一** — ルートディレクトリ + `.crawl-kit/` が唯一の作業単位。成果物 `data/` もワークスペース直下。単一リポジトリでもワークスペースを作る。既存の per-repo `data/` は移行。
2. **intent は自動ドラフト生成** — 統合コマンドが distill-ddd の分析モードを非対話で呼び、ドラフト intent.json を生成。パイプラインは止まらない。精緻化は後から対話セッション（/ddd）で可能。
3. **viewer はビルドなし SPA 継続** — サーバ側 view-model 組立 + 素の ES modules + hash ルーティング。ビューごとに小さな .js に分割。
4. `e2e.config.yaml` は `.crawl-kit/workspace.yaml` に統合する（スキーマは既存 `ConfigSchema` を土台に拡張、移行コマンド提供）。
5. 既存 `run` コマンドを統合コマンドとして再定義する。

## A. ワークスペースモデル

```
my-workspace/
├── .crawl-kit/
│   ├── workspace.yaml      # 唯一の設定ファイル（現行 e2e.config.yaml スキーマの進化版）
│   ├── repos/<name>.yaml   # リポジトリ単位の分析設定（setup が生成・更新）
│   └── progress.json       # 進捗台帳
├── data/                   # 全成果物（intent/structure/behavior/reconcile/verify）
├── .crawl-kit-cache/       # フラグメントキャッシュ（既存、ワークスペース直下へ）
├── .e2e/                   # behavior 実行状態（既存、ワークスペース直下へ）
├── backend/                ← git clone
├── frontend/               ← git clone
└── admin-frontend/         ← git clone
```

> 補足: フラグメントキャッシュは実装上リポジトリ直下 `<repo>/.crawl-kit-cache/` に置く（コンテンツアドレスで repo に従属するため、上図のワークスペース直下 `.crawl-kit-cache/` とは別）。
> `clear` はワークスペース直下と各 repo 直下の両方を対象にする。

### workspace.yaml

既存 `packages/behavior/src/config/schema.ts` の `ConfigSchema` を土台に拡張:

- `repositories[]` — `{name, label, url, role, audience, branch?, path?}`。`path` はワークスペース内のクローン先（デフォルト = name）。
- `targets[]` / `auth` / `databases[]` / `launch` / `setup[]` / `crawl` / `grow` — 既存のまま。
- `maxParallel` — 全フェーズ共通の並列上限（既存 `CLAUDE_CODE_MAX_CONCURRENCY` を統合。デフォルト 3。環境変数が指定されていれば env が優先）。
- `regenerateTtlSeconds` — 再生成判定 TTL（デフォルト 86400 = 24h。既存 freshness の ttlSeconds と統合）。

### repos/<name>.yaml（setup が生成）

- `framework` — 検出フレームワーク（Laravel / Next.js / …、既存 knowledge/*.md のキーに対応）
- `structure` — プロジェクト構造サマリ（ルーティング定義の場所、コントローラ/モデル/リポジトリのディレクトリ）
- `devServer` — 開発環境の起動方法（コマンド、ポート、docker-compose 参照）
- `dbAccess` — DB アクセス方法（接続情報の取得元: .env / config ファイル、workspace.yaml の databases[] との対応）
- `claudeMd` — CLAUDE.md 由来か自動分析かの出所メモ

### パス解決（contract/paths.ts 拡張）

- `findWorkspaceRoot()`: カレントから上方向へ `.crawl-kit/workspace.yaml` を探す。見つかればそこがワークスペースルート。
- 見つからない場合は従来の `findRepoRoot()` にフォールバック（移行期間の互換）。ただし新機能（setup/run/viewer 4メニュー）はワークスペース前提。
- `crawl-kit migrate` — 既存 per-repo `data/` + `e2e.config.yaml` 運用からワークスペースへの移行コマンド（data/ の移動、e2e.config.yaml → workspace.yaml 変換）。

### setup コマンド

`crawl-kit setup [dir]`:

1. ルートディレクトリを初期化（`.crawl-kit/` 作成、workspace.yaml 雛形）
2. リポジトリ URL を対話で受けて `git clone`（既に workspace.yaml に repositories[] があればそれを clone）
3. 各リポジトリについて:
   - `CLAUDE.md` があればプロジェクト構造情報をそこから取得
   - なければ LLM でプロジェクト構造を分析
   - 開発環境の起動方法・DB アクセス方法を探索（package.json / composer.json / docker-compose / README / .env.example）
   - **わからない項目は自力探索の後、ユーザーに確認**（対話プロンプト）
4. `.crawl-kit/repos/<name>.yaml` に保存
5. targets / auth / databases の雛形を workspace.yaml に書き、必要な環境変数（ID/Pass 等）を案内

冪等: 再実行時は既存設定を尊重し、欠けている項目のみ埋める。

## B. プリフライト（doctor）

`crawl-kit doctor`（単独実行可）+ `crawl-kit run` 起動時に自動実行。

チェック項目:

| 項目 | 方法 | 失敗時の影響 |
|---|---|---|
| distill-ddd インストール | CLI 検出 | intent フェーズをブロック（インストール案内 URL 提示） |
| リポジトリのクローン状態 | path 存在 + git rev-parse | structure をブロック |
| DB 接続 | 既存 `DbAdapter` で `SELECT 1` | behavior の DB 観測（更新検知・CRUD oracle）をブロック |
| ログイン設定 | auth 要否 / loginUrl・loginPath / usernameEnv・passwordEnv の存在 | behavior をブロック |
| target baseUrl 到達性 | HTTP HEAD/GET | behavior をブロック |
| Playwright | ブラウザバイナリ検出 | behavior をブロック |

- 結果は ✓/✗ 表 + 修正ガイダンスで表示。
- **DB・ログイン等の失敗は behavior フェーズのみブロック**。intent / structure は続行できる。
- ブロック理由は progress.json の `blockedReason` に記録し、ダッシュボードが「なぜこのメニューにデータが無いか」として表示する。

## C. 統合コマンド `crawl-kit run`

```
crawl-kit run [--only intent|structure|behavior] [--force]
 ├─ 0. preflight（doctor 相当）
 ├─ 1. viewer 起動（port 4317。以降ユーザーはリロードで進捗確認）
 ├─ 2. intent    : distill-ddd 自動ドラフト → intent.nodes.json + intent.aggregates.json
 ├─ 3. structure : repo ごとに既存 T1-T9 インクリメンタル分析（Pass1→Pass2→Pass3）
 │                 + 集約×エンティティマッピング（mapping.aggregate-entity.json）
 ├─ 4. reconcile（既存）
 ├─ 5. behavior  : crawl（BFS+クリック発見・実装済）+ crud + サイトマップ生成
 └─ 6. reconcile → verify（既存）
```

### 進捗台帳 `.crawl-kit/progress.json`

```jsonc
{
  "runId": "…",
  "phases": {
    "intent":    { "status": "completed", "startedAt": "…", "completedAt": "…",
                   "tasks": { "total": 3, "completed": 3 } },
    "structure": { "status": "running",
                   "tasks": { "total": 42, "completed": 17 } },   // unit×pass 単位
    "behavior":  { "status": "blocked", "blockedReason": "DB接続失敗: …",
                   "tasks": { "total": 0, "completed": 0 } }      // ページ/CRUDプラン単位
  },
  "updatedAt": "…"
}
```

- タスク登録: 各フェーズ開始時に計画タスク（structure = 分析 unit × pass、behavior = クロール対象ページ + CRUD プラン）を total に登録し、完了ごとに completed をインクリメント。書き込みは contract の atomic I/O を使用。
- ダッシュボード・CLI 進捗表示の共通ソース。

### resume / clear

- 再実行時は台帳 + 既存 freshness（TTL + content hash、`data/acquisition.json` / `.crawl-kit-cache/`）により**未完了・期限切れ分のみ**実行。途中で止めても続きから再開できる。
- `--only intent|structure|behavior` で単独実行。単独実行の場合、対応するメニューのデータのみ更新される（他メニューが空である理由はダッシュボードが説明する）。
- `crawl-kit clear [--phase intent|structure|behavior]` — 台帳・キャッシュ・成果物を消して一から再生成（テスト用）。`--force` は clear + run 相当。
- 再生成判定 TTL はデフォルト 24h（`regenerateTtlSeconds`）。

### 並列実行

- `maxParallel` を全フェーズ共通の上限とし、structure の fan-out・behavior のページ処理・LLM 呼び出しはこの上限を超えない。
- 全体タスク数と完了数を台帳に記録し、ダッシュボードで管理できるようにする。

## D. intent フェーズ

1. distill-ddd 検出。なければインストール案内（https://github.com/tango238/distill-ddd）を表示し、intent フェーズを `blocked` として台帳に記録。**統合実行は structure / behavior へ続行する**（集約×エンティティマッピングなど intent 依存の成果物はスキップされ、ダッシュボードが理由を表示）。
2. `docs/domain/intent.json` が存在し TTL 内なら再利用。なければ distill-ddd の分析モード（--analyze 相当）を非対話実行してドラフトを生成。
3. 既存 `emitIntentNodes` で `data/intent.nodes.json`（concept / event / transition）を出力。
4. **新規**: `data/intent.aggregates.json` — 集約とその構成概念（distill-ddd の集約フェーズ出力から抽出）。
5. **新規**: 集約×エンティティマッピング — structure Pass2 完了後、LLM が structure のモデル/リポジトリ/エンティティを intent の集約へマッピングし `data/mapping.aggregate-entity.json` を出力（confidence + evidence 付き。reconciler の evidence 形式に準拠）。

> **設計修正（P3, 2026-07-03 実装時）**: 上記 D-1/D-2 の「distill-ddd の --analyze 相当を非対話実行」は成立しないことが判明した。distill-ddd は独立 CLI ではなく Claude スキル（`/ddd`）であり、`emit_intent.py` が `docs/domain/intent.json` を書き出す構成のため、CLI として非対話呼び出しできる対象がない。ADR-0002（contract-only 連携）の方針に沿い、**crawl-kit 自身が LLM プロバイダ（structure と同じ `getProvider` 系、`ANTHROPIC_API_KEY` / `USE_CLAUDE_CODE`）で intent.json 契約形式のドラフトを生成**する（`packages/intent/src/draft.ts` の `draftGlossary`）。distill-ddd（`/ddd` スキル）は精緻化の正道としてガイダンスに案内する。doctor の「distill-ddd CLI 検出」は「intent ソース検査」（intent.json 存在 or distill-ddd CLI or LLM プロバイダ利用可のいずれか）に置き換えた。D-5 の集約×エンティティ相関も LLM 一発ではなく **reconciler が unified.json から機械導出**し（`deriveAggregateEntityMapping`）、未マッチのエンティティのみ名前類似ヒューリスティックで confidence/evidence 付き補完する。詳細は `docs/superpowers/plans/2026-07-03-p3-intent-autodraft.md` を参照。

## E. structure フェーズ

既存 T1-T9 をそのまま使う（Pass1 ルート = システム境界 → Pass2 エンティティ/CRUD/イベント → Pass3 情報モデル/ユースケース）。追加点:

- **マルチリポ対応**: workspace.yaml の repositories[] を順に（または並列に）分析。成果物の各レコードに `repo` タグを付与してマージ。フロントエンド repo は画面ルート/ API 呼び出し、バックエンド repo はルーティング/エンティティ/CRUD が主。
- Pass2 の出力（モデル/リポジトリクラスと EntityOperation）が集約×エンティティマッピング（D-5）の入力になる。
- UC×エンティティ CRUD 相関は既存 `uc_entity_crud` を使用。

## F. behavior フェーズ

既存: BFS + ボタン/クリックターゲット発見（discover.ts）、CRUD レコーダー（transactions.jsonl）、active CRUD、DB introspect/probe。追加点:

- **preflight ゲート**: DB / ログイン / baseUrl チェックを通過しない場合はフェーズ全体をブロックし理由を台帳へ。
- **画面遷移時のデータ更新観測**: mutation 系トランザクション（POST/PATCH/PUT/DELETE）に対し、既存 DB probe で更新の有無を確認しトランザクションへ `persisted` 印を付与（既存 boundary の not-persisted/roundtrip-ok を通信ログ単位へ展開）。
- **新規成果物 `data/behavior.sitemap.json`**: クロールグラフ + transactions から画面遷移ツリー（ページ → 表示されたアクションエレメント → 押下 → 遷移先/発生トランザクション）を生成。
  - 現状の実装は page→page + via（kind/label）に絞ったツリーで、遷移ごとのトランザクション紐付け（どの遷移でどの通信が発生したか）は未実装（P5 で必要になれば拡張）。
- **P5 の通信ログ join**: structure↔behavior のルートキー正規化（旧 reconciler 内 `normalizeRoute`）は `@crawl-kit/contract` の `normalizeRoute` へ移動済み。viewer は contract のみに依存するため、通信ログの tx↔route join はこちらを使用する。

## G. viewer 4メニュー + ダッシュボード

ビルドなし ES modules + hash ルーティング。`packages/viewer/public/` にビューごとの小さな .js。サーバは view-model JSON 群を返す（既存 `/view-model.json` を分割拡張）。

- **ダッシュボード `/`**: progress.json + 成果物の有無から
  - intent / structure / behavior の対応状況（フェーズ別ステータス・タスク進捗バー: completed/total）
  - 「何が未実行だからどのメニューのデータが表示されていないか」のガイダンスメッセージ（blockedReason 含む）
- **intent**: イベント / 集約 / 状態遷移（集約×イベント）
- **structure**: ルーティング / ユースケース / エンティティ / ER図 / エンティティ×UC
- **behavior**:
  - 通信ログ — アクセスした URL（軸）× 表示されたアクションエレメント（リンク/ボタン）× 押下したもの → ネットワークログ（URL, メソッド, Query/Body Param, Request/Response）。**structure のルーティングと一致する URL のみ表示**。
  - 画面遷移 — behavior.sitemap.json をツリー表示
- **観測マップ（intent→structure→behavior）**:
  - イベント / 状態遷移 — どの層が欠落しているか色分け（intent と structure がベース、behavior は観測結果から逆算して推測）
  - システム境界（structure→behavior） — structure のルーティング × 実際にアクセスしたページと表示されたボタン/リンク

viewer は `run` 実行時に自動起動し、リロードで最新の進捗・成果物を反映する。

## H. 成果物一覧（新規・変更）

| ファイル | 状態 | 内容 |
|---|---|---|
| `.crawl-kit/workspace.yaml` | 新規 | 統合設定（e2e.config.yaml を吸収） |
| `.crawl-kit/repos/<name>.yaml` | 新規 | リポジトリ単位の構造/起動/DB 設定 |
| `.crawl-kit/progress.json` | 新規 | 進捗台帳（フェーズ・タスクカウント・ブロック理由） |
| `data/intent.aggregates.json` | 新規 | 集約と構成概念 |
| `data/mapping.aggregate-entity.json` | 新規 | 集約×エンティティ相関（evidence 付き） |
| `data/behavior.sitemap.json` | 新規 | 画面遷移ツリー |
| `data/*`（既存） | 変更 | 置き場所がワークスペース直下に統一。structure 系レコードに repo タグ追加 |

## I. 実装フェーズ分解

| Phase | 内容 | 依存 |
|---|---|---|
| P1 | workspace/paths/進捗台帳（contract 拡張）+ `setup` + `doctor` + `migrate` | なし |
| P2 | `run` オーケストレータ（resume / clear / viewer 自動起動 / タスクカウント / 並列上限） | P1 |
| P3 | intent 自動ドラフト（distill-ddd 連携）+ 集約 + 集約×エンティティマッピング | P1 |
| P4 | behavior 追加分(サイトマップ生成・persisted 印・preflight ゲート) | P1 |
| P5 | viewer 4メニュー + ダッシュボード | P2-P4 の成果物スキーマ |

- 各フェーズは独立に spec → plan → 実装のサイクルを回す（本 spec が親）。
- 実装統制: 設計 = Fable / 作業統制 = Opus 4.7 / 実装 = Sonnet / 実装確認 = Opus 4.7 / 最終チェック・ヌケモレ確認 = Fable。
- タスクはできるだけ小さく分解して並列実行し、`maxParallel` を超えない。全体タスク数・完了数は progress.json に記録しダッシュボードで管理。

## J. エラーハンドリング / テスト方針

- 進捗台帳・成果物の書き込みは contract の atomic I/O。中断（Ctrl-C / クラッシュ）後も台帳は最後の完了タスクまでを保持し、再実行で続きから。
- フェーズ失敗は台帳へ `status: failed` + 理由。後続の依存フェーズはスキップ（behavior は structure Pass1 partial があれば CRUD 計画可能 — 既存 T8 の性質を維持）。
- テスト: 各パッケージ Vitest ユニット + fixture ワークスペース（`demo` を workspace 形式に更新）での E2E。clear → run → 中断 → resume のシナリオテストを必須とする。
