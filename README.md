# crawl-kit

> **「設計した通りに作られ、作った通りに動いているか」を一目で見えるようにするツール。**

ソフトウェアには、いつも3つのバージョンが同居しています — *意図したもの*・*実際に作ったもの*・*実際に動いているもの*。
この3つは、悪気なく、まっとうなコミットを1つ重ねるたびに、静かにズレていきます。crawl-kit はそのズレを**一箇所に並べて、食い違っている所を色で教えます**。

---

## こんな経験はありませんか？

- 設計ドキュメントとコードが食い違っていて、**どちらが正しいのか誰も分からない**
- 「この仕様、実装されてるはずだよね？」→ 実は**作られていなかった／別物になっていた**
- 「Payment は Shipping に依存させない」と決めたのに、**いつの間にか依存していた**
- 新メンバーが**モデル図を信用できない**（図とコードが別物だから）
- レガシーに機能を足したいが、**今どう動いているのかの全体像が掴めない**

これらはすべて「3つのバージョンがズレている」ことが原因です。crawl-kit は**そのズレ自体を成果物にします**。

## crawl-kit が解決すること

3つのバージョンは、それぞれ別のツールが別の視点で記述しています。

| バージョン | 何か | どこから来るか | ツール |
|---|---|---|---|
| **intent（意図）** | こう作りたかった | ドメインモデリング | [distill-ddd](https://github.com/tango238/distill-ddd) |
| **structure（構造）** | 実際にこう作った | ソースコードを静的解析 | crawl-kit |
| **behavior（挙動）** | 実際にこう動いている | 動くアプリをクロール＆検証 | crawl-kit |

ほとんどのツールはこのうち**1つ**しか見せてくれません。3枚の絵を別々に眺めても、同じものを違う名前で呼んだ図を行き来して頭の中で突き合わせるだけ — **情報は増えても理解は増えません**。

crawl-kit は3枚を重ねるのではなく、**間の「辺（差分）」を引いて、食い違う辺を色づけます**。
1つの概念（例: `Order`）を選ぶと、その**意図・構造・挙動が横一列に並び**、ズレている所が光ります。

### 中心は「検証」、差分はその前段

crawl-kit の **Core（中心）は検証（Verification）** です。intent と structure が決まれば、挙動は**自ずと決まるはず** — その「決まるはずの挙動」を実際に走らせ、**想定通りに動くかを裏取り**します。behavior は対等な第三の意見ではなく、設計を裏取りする**結果（オラクル）**です。

その検証の**基準（＝何が正しいか）を固める前段**が、intent↔structure の差分です。ここは欲張らず、機械的に取り出せて食い違いがいちばん効く2軸だけを見ます:

- **軸は intent（意図）**。意図にある項目だけを行にし、意図に無い構造・挙動は「候補」として脇に置く。
- **見るのはイベントと状態遷移**の2軸。

流れは `intent / structure / behavior（観測）→ reconcile（unified に結合）→ 検証（後段）`。
（なぜ差分そのものは Core でないか＝intent は外部供給で所有しないから、等は [docs/domain/discovery.md](./docs/domain/discovery.md) 参照。）

## CLI（`crawl-kit`）— npx で1コマンド

機能は `crawl-kit` という1つのコマンドにまとまっています。

```bash
npx @tanago3/crawl-kit demo              # 同梱サンプルで一連を実行
npx @tanago3/crawl-kit setup [dir]       # ワークスペース初期化: git clone + .crawl-kit/ 生成（対話）
npx @tanago3/crawl-kit doctor            # プリフライト: distill-ddd / repo / DB / ログイン / target / playwright
npx @tanago3/crawl-kit migrate [dir]     # 既存の e2e.config.yaml + data/ 運用をワークスペースへ移行
npx @tanago3/crawl-kit run               # intent→structure→behavior→reconcile→verify を1コマンドで通しで実行（resume/--only/--force）
npx @tanago3/crawl-kit clear             # 台帳・成果物をクリアして一から再生成（--phase intent|structure|behavior/--all）
npx @tanago3/crawl-kit analyze <repo>    # structure + behavior を両方取得（鮮度ゲート付き。--ttl/--force/--target）
npx @tanago3/crawl-kit analyze-structure <repo>  # 静的解析のみ → data/structure.*.json
npx @tanago3/crawl-kit analyze-behavior  # 実アプリをクロール（loop-e2e 経由）→ data/behavior.nodes.json
npx @tanago3/crawl-kit intent <glossary> # intent.json を取り込み → data/intent.nodes.json
npx @tanago3/crawl-kit reconcile         # 三層を正準IDで結合 → data/unified.json（ADRS_PATH=... で ADR）
npx @tanago3/crawl-kit verify            # concept + 境界の検証 → data/*.findings.json
npx @tanago3/crawl-kit behavior-plan     # 鮮度から crawl/skip/drop ページを算出（loop-e2e が消費）
npx @tanago3/crawl-kit serve [--port N]  # ビューア起動（ダッシュボード + intent/structure/behavior/観測マップ の4メニュー）
```

- `data/` は**実行したプロジェクトのルート**（最寄りの package.json）に作られます。
- **`analyze` は structure と behavior の両方**を鮮度ゲート付きで取得（`analyze-structure` / `analyze-behavior` で個別実行も可）。
- **behavior の実取得**はブラウザ駆動のため重い。crawl-kit が **loop-e2e エンジン（`@crawl-kit/behavior`）をサブプロセスとして起動**し、対象アプリを実クロールします（`.crawl-kit/workspace.yaml`／レガシー経路は `e2e.config.yaml`＋対象アプリ＋playwright が必要）。**このエンジンは npx 配布のバンドルに含まれず（内部 private パッケージ）**、純 `npx @tanago3/crawl-kit` 単体では behavior 実取得はできません（`resolveLoopE2e()` が解決できず structure のみ取得して警告）。behavior まで回すには **crawl-kit のリポジトリ/ワークスペースから実行**してください。
- **このリポジトリから直接**動かすなら（公開前）: `pnpm build` 後に `pnpm crawl-kit <command>`。
- **公開する**（誰でも `npx @tanago3/crawl-kit` できるように）: npm にログイン後 `pnpm release`。CLI は **1つの自己完結パッケージ `@tanago3/crawl-kit`**（依存ゼロのバンドル）として publish します（内部の `@crawl-kit/*` は private のままバンドルに同梱）。インストール後のコマンド名は `crawl-kit`。
  - 補足: 素の `crawl-kit`（unscoped）は npm の類似名ガード（既存 `crawlkit`）で弾かれるため、ユーザースコープ `@tanago3/` を使用。別名で出したい場合は `packages/cli/package.json` の `name` を変更。

### ワークスペース（setup / doctor / migrate）

複数リポジトリ（backend / frontend / admin-frontend 等）を横断するときは、1つの**ワークスペース**にまとめて運用します。

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
├── frontend/                ← git clone
└── admin-frontend/         ← git clone
```

- **`setup [dir]`** — ワークスペースを初期化します。`.crawl-kit/workspace.yaml` を作り、対話でリポジトリ URL を受けて `git clone`、各リポジトリの構造（フレームワーク・起動方法・DB アクセス）を分析して `.crawl-kit/repos/<name>.yaml` に保存します。冪等なので再実行時は既存設定を尊重し、欠けている項目だけ埋めます。
  ```bash
  npx @tanago3/crawl-kit setup ./my-workspace
  ```
- **`doctor`** — 実行前のプリフライトチェックです。`distill-ddd` の導入状況 / リポジトリの clone 有無 / DB 接続 / ログイン設定 / target への到達性 / Playwright の導入を ✓/✗ と修正ガイダンスで表示します。DB・ログイン等の失敗は `behavior` フェーズのみをブロックし、`intent` / `structure` は続行できます（ワークスペース外で実行した場合は案内を出して終了、exit code は 0）。
  ```bash
  npx @tanago3/crawl-kit doctor
  ```
- **`migrate [dir]`** — 既存の per-repo 運用（リポジトリ直下の `e2e.config.yaml` + `data/`）をワークスペースへ移行します。リポジトリのルートがそのままワークスペースルートになるので `data/` は動かさず、設定だけ `.crawl-kit/workspace.yaml` に変換します（`e2e.config.yaml` は残置）。
  ```bash
  npx @tanago3/crawl-kit migrate ./existing-repo
  ```

### 統合実行（run）とクリア（clear）

ワークスペースが `setup` 済みなら、intent → structure → behavior → reconcile → verify を1コマンドで通しで走らせられます。

```
crawl-kit run [--only intent|structure|behavior] [--force] [--no-viewer] [--port N]
 ├─ 0. preflight（doctor 相当。ブロックされたフェーズは台帳に記録し、他フェーズは続行）
 ├─ 1. viewer 起動（既定 port 4317。以降はブラウザのリロードで進捗確認できる。--no-viewer で無効化）
 ├─ 2. intent    : docs/domain/intent.json を取り込み（無ければ LLM で自動ドラフト）→ data/intent.nodes.json + data/intent.aggregates.json
 ├─ 3. structure : repo ごとに既存の T1-T9 インクリメンタル分析（Pass1→Pass2→Pass3）
 ├─ 4. behavior  : crawl（BFS+クリック発見、リダイレクト解決済みナビゲーションエッジ記録）→ crud（DB+reseed+認証が揃うときだけ能動実行）→ emit（画面遷移ツリー生成 + mutation tx へ persisted 印付け）
 └─ 5. reconcile → verify（既存）
```

```bash
npx @tanago3/crawl-kit run                       # フルパイプライン（intent〜verify）
npx @tanago3/crawl-kit run --only structure       # structure（+ reconcile/verify）だけ
npx @tanago3/crawl-kit run --force                # 台帳・成果物をクリアしてから再実行
npx @tanago3/crawl-kit run --no-viewer            # viewer を起動しない（CI・スモークテスト向け）
```

- **進捗台帳** `.crawl-kit/progress.json` — 各フェーズの `status`（`pending`/`running`/`completed`/`blocked`/`failed`）と、`blocked`/`failed` なら理由（`blockedReason`）、`tasks.total`/`tasks.completed`（structure=unit×pass、behavior=クロール対象ページ数）を記録します。「どのフェーズが・なぜ止まっているか」はこのファイルとダッシュボード（`serve`）の両方から読み取れます。
- **resume** — 再実行すると、`completed` かつ `regenerateTtlSeconds`（既定 24h）以内のフェーズは `skip（completed, TTL(…)内）` として即座に飛ばされます。`failed` のまま終わった・`--force` でクリアされたフェーズは次回そのまま再実行されます（structure/behavior は unit・ページ単位でキャッシュされるので再実行は安価）。
- **`--only intent|structure|behavior`** — 指定フェーズ＋reconcile／verify のみ実行します（他フェーズは触らず `pending` のまま残ります）。
- **doctor によるブロック** — distill-ddd 未導入・リポジトリ未クローン・DB接続失敗・target 未起動など doctor が検出した問題は、該当フェーズを `blocked` として台帳に記録した上で**他のフェーズは続行**します。例えば distill-ddd が未導入でも `docs/domain/intent.json` が既にあれば intent は続行、無ければ blocked（同様に behavior は target/DB/playwright いずれか未整備でも blocked、structure/intent は続行）。
- **並列実行** — `workspace.yaml` の `maxParallel` が全フェーズ共通の上限になります（structure の fan-out、behavior のページ処理・LLM 呼び出し）。

#### intent 自動ドラフト

`docs/domain/intent.json` が無いワークスペースで `run` すると、intent フェーズは **crawl-kit 内蔵の LLM でドラフトを自動生成**します（structure と同じプロバイダ切り替え: `ANTHROPIC_API_KEY` または `USE_CLAUDE_CODE=true`）。生成したドラフトはそのまま `docs/domain/intent.json` として書き出されるので、以降の実行では通常の「既存 intent.json を読む」経路を通ります。

- **distill-ddd（`/ddd` スキル）との関係** — distill-ddd は独立 CLI ではなく Claude スキル（`/ddd`）です。自動ドラフトは対話モデリングの代わりではなく、対話セッションを起こすまでの**つなぎ**（骨組みだけの intent.json）です。ドメインモデルを精緻化したくなったら `/ddd` の対話フェーズ（`python3 <skill>/scripts/emit_intent.py docs/domain`）で `docs/domain/intent.json` を作り直せば、次の `run` はそちらを優先して読み込みます。両者は同じ `intent.json` 契約形式（`Glossary`）を介してのみ連携するので、どちらで作った intent.json でも後続フェーズは区別しません。
- **LLM プロバイダが無い場合** — `ANTHROPIC_API_KEY` / `USE_CLAUDE_CODE` のどちらも未設定で `docs/domain/intent.json` も無ければ、intent フェーズは `blocked`（`blockedReason` に「LLM プロバイダ」が含まれる）になります。パイプライン全体は止まらず、structure / behavior は続行します。
- **成果物** — intent フェーズは `data/intent.nodes.json` に加えて **`data/intent.aggregates.json`**（集約とその構成概念）を書き出します。structure の分析が済んで reconcile が走ると、**`data/mapping.aggregate-entity.json`**（集約×エンティティの相関。confidence + evidence 付き）が追加で生成されます — これは reconciler が `unified.json` から機械的に導出したもので、集約に直接紐付かないエンティティは名前類似ヒューリスティックで補完され、それでも決まらないものは `unassigned` に残ります。
- **behavior の成果物** — crawl（BFS）中に踏んだリンク／クリック遷移を **`data/behavior.edges.json`**（`{ runId, edges: NavEdge[] }`、各エッジは `from`/`to`/`kind`（`"link"` | `"click"`）/`label?`）として記録します。`crawl-kit run` が `loop-e2e run` → `emit`（または `analyze-behavior` 相当）を順に実行する際、そのエッジ集合とクロール済みページから **`data/behavior.sitemap.json`**（画面遷移ツリー: `roots`（各ノードが `url`/`via?`/`children` — ルートノードに `via` は無い）+ どのエッジからも辿れないページの `orphans`）を生成します。また mutation（POST/PUT/PATCH/DELETE）の tx ノードには **`persisted`** 印（`yes`/`no`/`unknown`）が付きます — CRUD オラクル（作成→取得の突合）が実際の保存有無まで確認できたときだけ `yes`/`no`、mutation はあったが未検証（DB プローブ対象外、または DB 未接続）なら `unknown` です（GET 系にはそもそも印が付きません）。記録された各 mutation は **tx 単位のノード**（`behavior:tx/<route>#<seq>`）になるので、同一 route への複数呼び出しも個別に見えます（verdict は route 由来で各 tx が共有。tx ごとの個別 DB プローブは将来課題）。**`crawl-kit run` は DB接続・reseed（`launch.seed`）・target 認証が揃ったワークスペースでのみ crud を自動実行**して `persisted` を埋めます。いずれか未設定なら crud はスキップされ（台帳に理由を記録）、`persisted` は付きません（能動 CRUD 検証は破壊的なため、安全に戻せる設定が揃ったときだけ走ります）。

`crawl-kit clear [--phase intent|structure|behavior] [--all]` — 台帳・キャッシュ・成果物を消して一から再生成します（やり直し・テスト用）。

```bash
npx @tanago3/crawl-kit clear --phase structure   # structure の成果物 + キャッシュ + 台帳だけリセット
npx @tanago3/crawl-kit clear                     # intent/structure/behavior + 派生物（unified/findings）をリセット
npx @tanago3/crawl-kit clear --all               # 上記 + registry.json / decisions.json（人の判断）まで破棄
npx @tanago3/crawl-kit run --force                # clear 相当 + run（1コマンドでやり直し）
```

## いつ・どう使うか

> 前提（3層の初回セットアップ）と意味は [「自分のプロジェクトに当てる」](#自分のプロジェクトに当てる) を参照。とりあえず動かすなら `npx @tanago3/crawl-kit demo` → `npx @tanago3/crawl-kit serve`。

### リリース前 / PR レビュー
> 設計通りか・決めた制約を破っていないかを、人が見る前に機械でチェックする。

- **状況**: PR を出すたび、設計とのズレや制約違反を手で確認するのは大変。
- **やること**（CI ジョブに並べる）:
  1. 変更後のコードを解析する
     ```bash
     USE_CLAUDE_CODE=true npx @tanago3/crawl-kit analyze .
     ```
  2. 突き合わせて検証する
     ```bash
     npx @tanago3/crawl-kit reconcile
     npx @tanago3/crawl-kit verify
     ```
  3. `data/verification.findings.json` / `data/boundary.findings.json` を読み、高重大度があれば `exit 1`（差分を目で見たいときは `serve` の「観測マップ」メニュー）
- **できること**: `violates-decision`（決めた依存を破った）/ `not-persisted`（入力が保存されない）/ `runtime-error` で **PR を止められる**。findings は機械可読なので、しきい値判定をそのまま CI に書ける。

### オンボーディング
> モデル・コード・実挙動が同じ画面に並ぶので、新メンバーが全体像を掴める。

- **状況**: 新メンバーが入ったが、モデル図が古くコードと合っているか分からない。
- **やること**:
  1. ビューアを起動する
     ```bash
     npx @tanago3/crawl-kit serve
     ```
  2. ブラウザで `http://localhost:4317` を開き、サイドバーの「観測マップ」メニューを見る（まずダッシュボードでフェーズの進捗状況を確認するとよい）
- **できること**: 色で「どの図が現実と合っているか」が一目（`aligned`＝信用してよい / `intent-only`＝設計だけ）。`Order` を開けば**意図・コード・実挙動が同じ行**に並び、各画面が何を入力させ・表示し・保存するかも表で読める。古い図を読み解く代わりに、現実と突き合わせ済みの1画面で把握できる。

### レガシー把握
> 今あるコードと実挙動を棚卸しして、あるべき姿（意図）を後から重ねる。

- **状況**: ドキュメントの無いレガシー。まず「今どう動いているか」を知りたい（意図はまだ無くてよい）。
- **やること**:
  1. コードを解析する
     ```bash
     USE_CLAUDE_CODE=true npx @tanago3/crawl-kit analyze /legacy/repo
     ```
  2. 動くアプリをクロールした結果を取り込む（behavior は loop-e2e。出力を `data/behavior.nodes.json` に置く）
  3. 束ねて検証し、ビューアで見る
     ```bash
     npx @tanago3/crawl-kit reconcile
     npx @tanago3/crawl-kit verify
     npx @tanago3/crawl-kit serve
     ```
  4. （あとで）重要な所から意図を足す
     ```bash
     python3 <skill>/scripts/emit_intent.py docs/domain   # /ddd の emitter
     npx @tanago3/crawl-kit intent docs/domain/intent.json
     ```
- **できること**: route ごとの「入力→表示→保存」が現状の地図になり、`not-persisted`（入れても残らない）等で実挙動の癖が見える。`code-only` / `unmatched` が「設計に無い実装」をあぶり出す。意図を足すほど `intent-only` / `aligned` が育ち、棚卸しが前に進む。

### アーキテクチャの番人
> 「A は B に依存しない」等の決定を、口約束でなくコードから計算で守らせる。

- **状況**: 「Payment は Shipping に依存させない」と決めたのに、破られていないか不安。
- **やること**:
  1. 決定を ADR 制約として JSON に書く
     ```jsonc
     // adrs.json
     [{ "adrId": "adr:0010", "status": "accepted",
        "constraints": [{ "kind": "forbid-dependency", "from": "concept:payment", "to": "concept:shipping" }] }]
     ```
  2. その ADR を渡して突き合わせる
     ```bash
     ADRS_PATH=./adrs.json npx @tanago3/crawl-kit reconcile
     ```
  3. 結果を見る（`npx @tanago3/crawl-kit serve` で赤を確認、または `data/unified.json` の `violates-decision` を CI で判定）
- **できること**: コードが `payments → shipments` を生やすと **`violates-decision`（赤）を依存グラフから計算で検出**（本番で刺さる前に）。決定で説明済みのズレは `adjudicated`（欠陥ではなくモデルが追従中）。PR ごとに回せば取り決めの遵守を継続監視できる。

## 5分で試す

```bash
# 前提: Node 20+ / pnpm
pnpm install
pnpm -r build
pnpm -r test

# 同梱の e-commerce サンプルで「3層を束ねて差分を色づける」一連を実行
pnpm demo      # intent → structure → reconciler → verification（data/*.json を生成）
pnpm serve     # → http://localhost:4317  ダッシュボード + intent/structure/behavior/観測マップ の4メニュー（ライブ）
```

## 自分のプロジェクトに当てる

3層をそれぞれ生成して、束ねて、検証して、見る — の流れです。

> 複数リポジトリを1つの**ワークスペース**（[`setup`](#ワークスペースsetup--doctor--migrate)）で運用しているなら、以下を手で叩く代わりに [`crawl-kit run`](#統合実行runとクリアclear) が intent〜verify を1コマンドで通しでやってくれます（resume・`--only`・`--force` 対応）。ここでの手順は単一リポジトリ・ワークスペース未使用の場合の素朴な流れです。

```bash
# 1. intent: /ddd（distill-ddd）でドメインモデルを作る → intent.json を書き出す
#    （events は storming/events、状態遷移は aggregates フェーズで確定）
python3 ~/.claude/skills/ddd/scripts/emit_intent.py docs/domain   # → docs/domain/intent.json
pnpm --filter @crawl-kit/intent emit docs/domain/intent.json      # → data/intent.nodes.json

# 2. structure: 実リポジトリを静的解析（LLM 任意。未設定なら決定的フォールバック）
USE_CLAUDE_CODE=true pnpm --filter @crawl-kit/structure analyze /path/to/repo

# 3. behavior: loop-e2e のクロール結果を流し込む
pnpm --filter @crawl-kit/behavior emit <observation.json>

# 4. 束ねて検証
pnpm --filter @crawl-kit/reconciler run run    # 3層を正準IDで結合 → data/unified.json
pnpm verify                                    # 検証結果 → data/verification.findings.json

# 5. 見る
pnpm serve   # http://localhost:4317 「観測マップ」メニューで差分・境界・検証結果を確認
```

> LLM バックエンド（`ANTHROPIC_API_KEY` / `USE_CLAUDE_CODE`）は **任意**。未設定でも決定的シグナルだけで動き、曖昧な分は手作業キューに回ります（オフラインで完全に再現可能）。
>
> LLM 呼び出しの同時実行数は `CLAUDE_CODE_MAX_CONCURRENCY=<n>`（既定 **3**）で上限を制御します（behavior / structure 共通、両バックエンドに適用）。`USE_CLAUDE_CODE=true` では `claude` サブプロセス（各数百MB）の同時起動数＝メモリ対策、`ANTHROPIC_API_KEY` では同時 API リクエスト数＝レートリミット対策として効きます。

## 画面の読み方

`pnpm serve` / `npx … serve` で起動すると、1つのシェル (`index.html`) にサイドバーの4メニューをぶら下げた SPA が開きます（ハッシュルーティング `#/...`）。サイドバーの一番上は常に **ダッシュボード**（`#/`）、その下に **intent / structure / behavior / 観測マップ** の4メニューが並びます。各ビューは自分専用の `/api/*.json`（または `/view-model.json`・`/diff.json`）を毎回フェッチする**ステートレス**な描画で、リクエストごとに `data/` の最新状態を反映します。

### ダッシュボード（`#/`）

`/api/dashboard.json` を描画。中身は2つ:

- **フェーズ進捗** — `intent / structure / behavior / reconcile / verify` の5フェーズぶんの進捗バー（`crawl-kit run` が書く `.crawl-kit/progress.json` 由来。ワークスペース外や `run` 未実行なら「進捗情報がありません」）。
- **メニュー状況（ガイダンス）** — 4メニュー（`behavior` は通信ログ/画面遷移の2項目に分かれるため実質5エントリ）それぞれについて、必要な成果物 (`data/*.json`) が揃っているか (`ok`) ・揃っていなければ理由 (`reason`。`progress.json` の `blockedReason` があれば括弧書きで併記) ・それを解消するコマンド (`command`、例: `crawl-kit run --only intent`) を返します。全メニューが `ok` なら「全メニュー対応済みです。」とだけ表示し、そうでなければ未対応のメニューだけを理由・コマンド付きでリスト表示します。

### intent（3ビュー）

- **イベント** (`#/intent/events`) — intent の発生イベント一覧
- **集約** (`#/intent/aggregates`) — 集約とメンバー／マッピングされたエンティティ
- **状態遷移** (`#/intent/transitions`) — 集約の状態遷移

いずれも `/api/intent.json` を参照。`data/intent.nodes.json` が無ければ各ビューは空状態（例:「イベントがありません。ダッシュボードの『メニュー状況』で intent フェーズの案内を確認してください。」）を表示し、500 にはなりません。

### structure（5ビュー）

**ルーティング** / **ユースケース** / **エンティティ** / **ER図** / **エンティティ×UC** (`#/structure/routes|usecases|entities|er|uc-entity`)。`/view-model.json`（`data/structure.rdra.json` 等の静的解析結果）を参照。未実行なら同様に空状態表示。

### behavior（2ビュー）

- **通信ログ** (`#/behavior/traffic`) — `/api/traffic.json`。URL軸・structure 一致による絞り込み・画面エレメントとの対応・`/transactions.jsonl`（生ndjson）の永続化された通信履歴。各 tx には **発生元の画面URL**が付き（記録時にページ文脈をスタンプ）、その mutation がどの画面で起きたかを辿れます
- **画面遷移** (`#/behavior/sitemap`) — `/api/sitemap.json`。クロールで得た画面遷移ツリー。各ノードには **その画面で起きた mutation 件数バッジ**が付き、通信ログと相互参照できます（ページ単位。どのクリックが引き金かのエッジ単位対応は対象外）。**未クロール**（`data/behavior.sitemap.json` が存在しない）は JSON `null` で返り、**クロール済みだが空**の `{}` と区別されます

### 観測マップ（3ビュー、旧単一ページ viewer を移植）

intent を軸に、イベント・状態遷移・システム境界を横並びで照合する、旧 `packages/viewer/index.html`（単一ページ viewer）由来のビュー群です。

- **イベント** (`#/map/events`)・**状態遷移** (`#/map/transitions`) — `/diff.json` の横並び差分。行は intent のイベント・状態遷移、列が intent / structure / behavior。intent / structure 列は🟢 緑 = 一致 ／ ⚠ 黄 = intent にあるが対応が無い（gap）。イベントの behavior 列は直接観測ではなく「そのイベントを発火する route が実行時に観測されたか」の逆算推測で、2状態のみ（緑「◇ route 経由で観測」／ 黄「⚠ not observed」、凡例に同じ注記あり）。状態遷移の behavior 列は行単位のデータを `/diff.json` が提供していないため「未提供（データなし）」表示（灰）で、対応する behavior 観測は下部の「候補」に直接観測として並びます。**候補** = コードや実挙動にあるが intent に無いもの（gap の埋め合わせ候補としてのみ表示）
- **システム境界** (`#/map/boundary`) — `/diff.json`。route ごとの「入力→表示→保存」の照合（`not-persisted` / `roundtrip-ok` 等）と、reconcile 済みモデルに対する裁定付き検証結果 (`violates-decision` / `unbuilt-intent` / `undocumented-runtime` / `runtime-error` を bug / uncertain / unnecessary で提示。ADR が説明するズレは `adjudicated` として区別)

### データが空のとき

`crawl-kit demo` を試す前や、ワークスペースで一部フェーズしか回していないときは、対応するメニューのビューが「〜がありません」という空状態メッセージと、ダッシュボードの「メニュー状況」を見るよう促す案内を表示します（サーバ側は欠落した成果物を空モデルとして扱うため、どのエンドポイントも 500 にはなりません）。まずダッシュボード（`#/`）でどのフェーズ・メニューが未対応かを確認し、表示された `crawl-kit run --only <phase>` を実行してください。

## 仕組み（背骨）

ひとつの**正準レジストリ**が背骨です。語彙（glossary）が概念ごとに1つのIDと名前を発行し、structure / behavior はそのIDで自分の出力にタグを付けます。すべてが同じIDで串刺しになるので、「同じ概念」を一箇所に集めるのは**翻訳ではなく単なる結合**になります。

別立ての **reconciler** が背骨を健全に保ちます。何が同じかを*証拠つき*（曖昧なスコアではなく）で提案し、自信のあるものは自動解決、本当に曖昧なものだけ人間のキューへ。人の判断はレジストリに**焼き込まれ**、次回は「新しく増えた分」だけを尋ねます。

## 3つの元ツール

crawl-kit は置き換えではなく、3つに**共通の背骨**を与えます。

- [**distill-ddd**](https://github.com/tango238/distill-ddd) — 対話的 DDD モデリング。**intent** を所有し、正準名を発行。
- [**rdra-analyzer**](https://github.com/tango238/rdra-analyzer) — ユースケース／情報モデルの静的抽出。**structure** を所有。
- [**loop-e2e**](https://github.com/tango238/loop-e2e) — AI 駆動クロール＋検証ループ。**behavior** を所有。

## もっと詳しく

| 読みたいこと | ドキュメント |
|---|---|
| ドメインモデル（discovery / 集約 / 差分の設計） | [docs/domain/](./docs/domain/) |
| なぜ・全体設計 | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| 契約スキーマの意味 | [docs/DATA-MODEL.md](./docs/DATA-MODEL.md) ＋ [`packages/contract`](./packages/contract) |
| リポジトリ構成・移植マッピング | [STRUCTURE.md](./STRUCTURE.md) |
| 進化に追従させる運用ガイド | [docs/OPERATIONS.md](./docs/OPERATIONS.md) |
| 用語 | [GLOSSARY.md](./GLOSSARY.md) |
| 設計判断の記録 | [docs/adr/](./docs/adr/) |
| 売り込み用の一枚 | [CONCEPT.md](./CONCEPT.md) |

### リポジトリ構成

```
packages/
  contract/      # 背骨：型 + 検証 + I/O（全員が依存）
  intent/        # glossary → 正準concept（ID発行）＋ events / 状態遷移
  structure/     # rdra 移植：静的解析 + events/状態遷移の決定的抽出 → emit
  behavior/      # loop-e2e 吸収：クロール観測 → route-keyed emit + 遷移
  reconciler/    # 証拠マッチ + 8状態分類 + ADR + 手作業キュー → unified.json
  verification/  # reconcile 済みモデルを「期待」として検証 → findings
  freshness/     # 取得鮮度：TTL＋内容ハッシュで structure/behavior の再取得を間引く
  viewer/        # ビューア: ダッシュボード + intent/structure/behavior/観測マップ の4メニュー（意図｜構造｜挙動を横並び + 境界 + 検証、ライブ）
  cli/           # `crawl-kit` 統合コマンド（npx エントリ。spine を1つに）
data/            # registry.json（永続・人の判断）/ unified.json（派生）
```

## ライセンス

MIT（各元ツールに準ずる）。
