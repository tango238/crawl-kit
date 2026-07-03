# 運用ガイド：進化し続けるコードに解析を追従させる

crawl-kit は「一度解析して終わり」ではなく、**コードが変わるたびに作り直し、人の確定知識は積み上げる**前提で設計されています。鍵は2つ:

1. **CLAUDE.md（または AGENTS.md）が解析の地図**。`analyze` は対象リポの CLAUDE.md / AGENTS.md ＋ フレームワーク知識を**毎回プロンプトに注入**して route / model / usecase / CRUD を抽出します。だから「どこに何があるか・命名規約・アーキテクチャ」を CLAUDE.md に書いておくほど、リポが育っても抽出がブレません。
2. **人の知識は2つのストアに焼き込まれ、再解析で消えない**:
   - `data/structure.corrections.json` … structure の補正（取りこぼし・CRUD 誤り等。[ADR-0009](./adr/0009-structure-corrections-overlay.md)）
   - `data/registry.json`（`data/decisions.json` 経由）… reconciler の同一性判断（[ADR-0007](./adr/0007-reconciliation-direction-threshold.md)）

## 0. 一度だけ：対象リポに地図を置く

対象リポ直下に **CLAUDE.md** を用意（無ければ作る）。書く内容の例（Laravel なら）:

```markdown
# MyApp
Laravel 11 + Inertia/React。

## 構成
- ルート: routes/web.php, routes/api_v*.php
- モデル(Eloquent): app/Models/*.php （$fillable / リレーション参照）
- コントローラ: app/Http/Controllers/**
- ドメインサービス: app/Services/**（ここで間接的な CRUD が起きる）
## 命名
- テーブルは snake_case 複数形。集約は Booking / Hotel / Room。
```

これが `analyze` の精度を支えます（フレームワーク自動検出＋知識シートも併用）。

## 1. 毎サイクル（リリース毎・大きめの変更毎）に3層を作り直す

```bash
# structure: 実コードを再解析（corrections.json は自動で再適用＝焼き込み）
# USE_CLAUDE_CODE=true は routes/controllers/models/pages を並列の claude エージェントで抽出する。
# 同時実行は既定 3。CLAUDE_CODE_MAX_CONCURRENCY=<n> で上限変更（behavior と共通・両バックエンド適用。
# claude-code はメモリ、API はレートリミット対策）。メモリが厳しいなら 1 に絞る。
USE_CLAUDE_CODE=true pnpm --filter @crawl-kit/structure analyze /path/to/repo
# behavior: loop-e2e のクロール結果を流し込む
pnpm --filter @crawl-kit/behavior emit <observation.json>
# intent: ドメイン語彙が変わったら glossary を更新
pnpm --filter @crawl-kit/intent emit <glossary.json>
# 突き合わせ（registry の人の判断は焼き込み済み → 新規・変更だけ要対応）
pnpm --filter @crawl-kit/reconciler run run
pnpm --filter @crawl-kit/verification run run
pnpm serve   # http://localhost:4317 で差分・検証結果をレビュー（/diff も）
```

## 2. 差分を見て、気づいた誤り・判断を「一度だけ」焼き込む

- **structure の抽出ミス**（テーブル取りこぼし／CRUD 誤り／集約と中間表の取り違え）→ `correct`:
  ```bash
  pnpm --filter @crawl-kit/structure correct add-entity rooms id,hotel_id,number hotels
  pnpm --filter @crawl-kit/structure correct set-crud user_profiles RU
  pnpm --filter @crawl-kit/structure correct rename-entity old new       # 改名（依存も追従）
  pnpm --filter @crawl-kit/structure correct list                        # 現在の補正一覧
  # 全再解析せず該当エンティティだけ LLM 調査して補正案を記録:
  USE_CLAUDE_CODE=true pnpm --filter @crawl-kit/structure correct investigate /path/to/repo rooms
  ```
  補正されたエンティティは LayerNode に `corrected: true` が付き、viewer で「人が直した」と分かります。
  未知エンティティへの補正は黙って捨てず skip として報告します。
- **reconciler の同一性の曖昧さ**（手作業キュー）→ `data/decisions.json`:
  ```json
  [{ "entityName": "clients", "conceptId": "concept:customer" }]
  ```
  registry に焼き込まれ、次回から聞かれません。

## CRUD 判定（本家 crud_analyzer 準拠・4ソース）

エンティティの CRUD は **entity_operations（コード由来・最強）∪ ルートのパス名照合（全ルート）∪ usecase** から決まります（`packages/structure/src/crud.ts`）。特に **ルートをエンティティ名でパス照合**するので `DELETE /hotels/{id}` が usecase 無しでも `hotels` の Delete になります（パスは部分一致ではなく**セグメント正規化**で照合し `hotel` が `hotel_images` に漏れない）。

## 取得鮮度（増分再取得 / Acquisition Freshness）

「広く全体取得」は高い（特に LLM 解析）。そこで**鮮度判定で間引く**。変化シグナルは**全ファイルの内容ハッシュ**（安い局所処理）、取得は鮮度が切れた時だけ。状態は `data/acquisition.json`（structure はディレクトリ名鍵、behavior は route 鍵）。

```bash
# analyze = structure + behavior を両方取得（どちらも鮮度ゲート付き）
crawl-kit analyze <repo> --ttl 86400 [--target NAME]
crawl-kit analyze <repo> --force          # 鮮度無視で全再取得

# 個別実行
crawl-kit analyze-structure <repo>        # 静的解析のみ（無変更&TTL内ならスキップ）
crawl-kit analyze-behavior                # loop-e2e で実クロール（鮮度OKならスキップ）
crawl-kit behavior-plan                   # crawl/skip/drop の計画だけ表示（取得しない）
```

- **behavior の実取得**は crawl-kit が **loop-e2e エンジン**（`@crawl-kit/behavior` の `loop-e2e` bin）を起動して実行する。`e2e.config.yaml`（対象 baseUrl/auth/db）＋playwright が必要。エンジン未導入なら structure のみ取得し警告（npx 単体配布にはブラウザ依存を含めないため）。

- **structure**: ディレクトリ単位。`now − lastAcquiredAt[dir] > TTL` **または** 配下ファイルの内容ハッシュに差（追加/削除/編集/リネーム）で再取得。ハッシュ不変なら構造不変とみなし cull。
- **behavior**: ページ（route）単位。`TTL 経過` **または** structure の route 増分（新規 crawl・消滅 drop）。`planBehaviorCrawl` が計画、crawl 後に `recordBehavior` で鮮度更新。
- **既存資産**: router/view 判定は `ParsedRoute` / `ParsedPage` で充足（新規作成不要）。新規は鮮度ストア＋ハッシュ走査＋route/page 差分のみ。

## 増分・分散・段階アナライザ（`analyze-structure --incremental`）

巨大リポ（例: Laravel 250テーブル/297ルート）では structure の LLM 解析が**リポ一括の直列 agentic 実行**で重くタイムアウトしがち。`--incremental` はこれを**解析単位ごとの並列ファンアウト＋差分＋段階化**に置き換える。

```bash
# 段階解析（Pass1=ルート一覧 → Pass2=詳細 → Pass3=跨ぎ）。既定は全パス。
crawl-kit analyze-structure <repo> --incremental
crawl-kit analyze-structure <repo> --incremental --pass 1        # ルート一覧だけ先に
crawl-kit analyze-structure <repo> --incremental --unit controllers/Admin  # 単位を絞る
crawl-kit analyze-structure <repo> --incremental --force         # 鮮度＋断片キャッシュ無視で全再解析
```

- **単位 (unit)**: リポを小さく独立に解析できる塊に分割（Laravel: `routes/*.php` はファイル毎、`app/Http/Controllers/**`・`app/Models/**` はサブディレクトリ毎。未知フレームワークはトップ階層ディレクトリ毎）。各単位に内容ハッシュを付与。
- **分散**: 単位ごとに **cwd/prompt をその単位のファイルに限定**した agentic 解析を、共有リミッタ（`CLAUDE_CODE_MAX_CONCURRENCY`）で束ねて並行実行。1単位が小さいので構造的にタイムアウトしにくい。
- **差分**: 断片を `<repo>/.crawl-kit-cache/fragments/<unit>-<hash>-p<pass>.json` にキャッシュ（キー = 単位ID×内容ハッシュ×パス）。**変わった単位のパスだけ**再解析、未変更はキャッシュ再利用。ハッシュ変化＝自動失効。
- **段階（progressive）**: Pass1 完了時点で `data/structure.routes.partial.json`（ルート一覧）を即書き出し、**e2e/CRUD 計画はここから開始可能**（`crud` は `structure.nodes.json` 未生成なら partial にフォールバックし、パスから entity を推論）。Pass2/3 で `structure.nodes.json` を詳細化・上書き。
- **同期ポイント**: 各パス末に断片をマージ（ルートは reconciler と同じ `normalizeRoute` で重複排除しパターン化、controller/model を統合、route→controller の跨ぎ参照を解決）。
- **既定 `analyze`（非 incremental）との関係**: 従来の `analyzeRepo`（リポ一括）は温存。`--incremental` は並行して選択できる別経路で、出力コントラクト（`structure.nodes.json` 等）は同一。

## 3. なぜ「進化に追従」できるのか

補正と判断は**追記され、毎回先頭から再適用**されます。だから:

- `analyze` がコードの変化で土台を総入れ替えしても、**前に直した点は自動で再修正**される（焼き込み）。
- reconciler は前回の判断を保持するので、再実行で**人が見るのは前回から変わった概念だけ**に収束する。
- 結果、サイクルを回すほど「未対応の差分」は減り、**コードの進化と解析・モデルが揃い続ける**。

> 補正は純粋なオーバーレイ、判断は registry への焼き込み。「自動解析の精度（何度でも作り直してよい）」と「人の確定知識（不変）」を分離しているのが核心です。CI に組み込めば、PR ごとに3層の差分を可視化できます。

## 4. DB 接続を足す（永続化観測を有効化）

`e2e.config.yaml` に `databases:` を追加すると、CREATE/UPDATE の永続化観測（`registeredData` verify / boundary の `roundtrip-ok`）が使えるようになる。パスワードは環境変数から読む（値そのものは書かない）。

```yaml
databases:
  - name: app
    type: postgres        # or mysql
    host: localhost
    port: 5432
    database: myapp
    user: myapp
    passwordEnv: DB_PASSWORD
```

- `passwordEnv` は環境変数名（例: `export DB_PASSWORD=...`）。設定ファイルに秘密を書かない。
- 複数接続は配列で並べる。scenario の `expectedDbState.connection` は `name` と一致させる。
- 接続を足しただけでは DELETE の観測（削除の実行・行の消滅確認）はまだ有効にならない（後続の能動 CRUD 実行フェーズで対応）。
- 実行中の API 通信は `.e2e/runs/<runId>.transactions.jsonl` に記録され、`report.md` の「API 通信ログ」節と viewer の「通信ログ (API)」タブで確認できる。
