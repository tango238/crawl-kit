# Viewer/Crawl 4-Point Fixes — 原因調査・対策・実装計画

> 作成: 2026-07-02 / ブランチ: `feat/incremental-analysis`
> 実装は別セッションで行う。本書は「原因調査 + 対策 + 実装計画（背景と裏付けデータ付き）」。

## 背景 (Overall Context)

roomport (`https://testing.roomport.jp`, Laravel 12 + 2FA admin) に対して A+B(観測) /
C+D(能動CRUD) を live 検証した結果、viewer に 2 つの症状が出た:

1. **ルートのデータがありません** — viewer のルート/観測マップに何も出ない
2. **通信ログ (API) のデータが少なすぎます（ログインだけ）** — トランザクションが 5 件のみ

viewer は `roomport/data/` を読む。現状の実データ（裏付け）:

```
$ ls -la /Users/go/work/hosty/roomport/data
acquisition.json              2.0 MB
behavior.nodes.json           4.4 KB
behavior.transactions.jsonl   18 KB   ← 5 行のみ (wc -l = 5)
structure.nodes.json          172 KB  ← 297 ルート抽出済み
structure.rdra.json           76 KB
structure.er.mmd / usecases.mmd / structure.usecases.mmd
# unified.json                 → MISSING
# intent.nodes.json            → 無し
```

- `structure.nodes.json` は **297 ルート**（153 mutating / 103 entity 付き）を持っているのに
  viewer にルートが出ない。
- `behavior.transactions.jsonl` は **5 行**しかない。

この 2 症状の直接原因が下記 4 点であり、それぞれの根拠・対策・タスクを示す。

---

## 症状と 4 点の対応関係

| 症状 | 直接原因 | 対応する Fix |
|------|----------|--------------|
| ルートが出ない | `unified.json` が生成されていない (`analyze` が `reconcile` を呼ばない) | **Fix 1** |
| API ログが少ない | `crud` が recorder を attach しない | **Fix 2** |
| API ログが少ない | crawl が `<a href>` しか辿らず、ボタン押下起点の画面に到達しない | **Fix 3** |
| API ログが少ない | crawl 到達ページが 2（`collect` は BFS せずシナリオ遷移のみ） | **Fix 4** |

---

## Fix 1: `analyze` 実行時に `reconcile` も自動実行する

### 根拠 (Evidence)

`packages/cli/src/index.ts`:

```
178  async function cmdAnalyze(args: string[]): Promise<void> {
179    await cmdAnalyzeStructure(args);
180    await cmdAnalyzeBehavior(args);
181  }                                       ← reconcile を呼んでいない
183  async function cmdReconcile(): Promise<void> {   ← unified.json / registry.json を生成する本体
...
226    await cmdReconcile();   ← 別の上位パイプラインコマンドでは呼ばれている
305    await cmdReconcile();   ← 同上
```

- `cmdReconcile` は intent/structure/behavior nodes を ingest → `reconcile()` →
  `unified.json` + `registry.json` を書き出す唯一の経路。
- `cmdAnalyze` はこれを呼ばないため、`analyze` だけ実行すると `unified.json` が生成されない。
- 実データ裏付け: `roomport/data/` に `structure.nodes.json`(172KB) は在るが `unified.json` は **MISSING**。
- viewer のルート/観測マップは `unified.json` を入力とするため、結果として「ルートのデータがありません」。

### 対策

`cmdAnalyze` の末尾に `await cmdReconcile();` を追加。structure/behavior の生成直後に
突き合わせ、`unified.json` を必ず出力する。

### タスク

1. `packages/cli/src/index.ts:180` の直後（181 の `}` の前）に `await cmdReconcile();` を追加。
2. `cmdReconcile` は引数を取らない (`cmdReconcile()`) ので、`args` の伝播は不要。
3. 既に `unified.json` が在る/無い両方のケースで冪等に動くことを確認
   （`cmdReconcile` は `ingestOrEmpty` で欠損ノードを空扱いするため intent 無しでも動く）。
4. 検証: `analyze` を単体実行 → `data/unified.json` と `registry.json` が生成される →
   viewer 起動でルートが表示される。

### 影響/リスク

- `analyze` 実行時間が reconcile 分だけ延びる（許容内、I/O 主体）。
- `intent.nodes.json` が無くても `reconcile` は structure+behavior だけで unified を作れる
  （現に上位パイプライン L226/L305 で同じ呼び出しが成立している）。

---

## Fix 2: `crud` コマンドに recorder を attach する

### 根拠 (Evidence)

`packages/behavior/src/cli/commands/crud.ts`:

```
121    const page = await browser.newPage()          ← recorder を挟まず素の page を生成
122    const auth = await authenticate(page, target, creds, {...})
130    const api = apiClientFromPage(page, target.baseUrl)   ← ここで実 API を叩く
```

crud には `createRecorder` / `withRecorder` の呼び出しが一切無い（上記 grep で確認済み）。

一方、他コマンドは recorder を必ず attach している:

```
packages/behavior/src/cli/index.ts:220   const recorder = createRecorder({...})
packages/behavior/src/cli/index.ts:407   ... withRecorder(launchedBrowser, recorder, 'crawl')   ← run
packages/behavior/src/cli/commands/explore.ts:91   const recorder = createRecorder({...})           ← explore
```

- `apiClientFromPage` は `page.evaluate(fetch)` でブラウザのネットワークスタック経由の通信を行う
  （host-resolver / cookie / recorder の `requestfinished` リスナから可視）。
- しかし crud は recorder を **生成も attach もしていない**ため、CRUD の実 API 通信
  (POST/GET/PATCH/DELETE) が `transactions.jsonl` に記録されない。
- 実データ裏付け: roomport 検証では crud で 10 プランを実行したにも関わらず、
  `behavior.transactions.jsonl` は **5 行**（ログイン等）のみ。CRUD 通信が落ちている。

### 対策

`run` の配線をミラーする。`browser.newPage()` の前に recorder を生成し、
`withRecorder(browser, recorder, 'crud')` でラップした browser から `newPage()` する。

### タスク

1. `crud.ts` 冒頭付近で `createRecorder`, `withRecorder` を import
   （`../../services/browser/recorder.js`）。
2. browser 取得後に:
   ```ts
   const recorder = createRecorder({ runId, root: cwd, baseUrl: target.baseUrl, secrets })
   const recordedBrowser = withRecorder(browser, recorder, 'crud')
   const page = await recordedBrowser.newPage()
   ```
   （`runId` / `cwd` / `secrets` は crud が既に持つコンテキストから取得。run/explore の生成箇所を参照。）
3. `withRecorder` の stage 引数はレポート分類用ラベル。`'crud'` を新設。
4. 終了時に recorder の flush/close を run と同様に行う（jsonl への emit を保証）。
5. 検証: roomport で `crud` を再実行 → `transactions.jsonl` に POST/GET/PATCH/DELETE が
   増える（マスキング適用済みであること）。

### 影響/リスク

- 記録が増える分 jsonl が大きくなる（既存のフル記録+上限キャップ+マスキング方針の範囲内）。
- recorder は既に run/explore で実績があるため回帰リスクは低い。

---

## Fix 3: `<a href>` だけでなくボタン押下もキャプチャする

### 根拠 (Evidence)

リンク発見は BFS discovery (`packages/behavior/src/services/browser/discover.ts`) が担うが、
抽出は **`<a href>` の正規表現のみ**:

```
discover.ts:74  /** Extract absolute, same-document `<a href>` links resolved against baseUrl. */
discover.ts:76  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi
```

- `<button>`, `role="button"`, `onclick`、JS ルーター (SPA) による遷移は一切拾えない。
- roomport の admin は JS 駆動ナビゲーションが多く、href を持たないボタンで画面遷移する。
- 実データ裏付け: run ログの access-control verify が `/build/assets/*.js` や `favicon.ico`、
  `/administrator/signin/reset-password` ばかりを候補として拾っており、発見リンクの多くが
  静的アセット。=「アプリ画面への到達がほぼ base 1 枚 + 静的リンク」であることを示す。

### 対策（2 段階）

正規表現による HTML パースでは JS 遷移は原理的に取れないため、
**DOM 上のクリック可能要素を列挙 → クリック → 遷移 URL を観測**する方式を追加する。

- 現状の `extractLinks(html)`（静的）に加え、`page.evaluate` でクリック候補セレクタ
  （`button`, `[role="button"]`, `[onclick]`, `a[href]`, `[data-href]` 等）を DOM から収集。
- 候補ごとに: 現 URL を退避 → クリック → `waitForLoadState` → URL が変わったら新ページとして
  enqueue、変わらなければ（モーダル/トグル等）rollback（`goto` で戻る）。
- 危険操作（logout, delete, submit 系）は既存の logout/exclude ガード + 追加セーフガードで除外。

### タスク

1. `discover.ts` に `discoverClickTargets(page)` を追加（`page.evaluate` でクリック候補の
   安定セレクタ or index を返す）。
2. BFS ループ内で `extractLinks`(静的 href) の後に、クリック起点の遷移探索を実行:
   クリック → URL 差分検出 → 新規なら `queue.push`。非遷移はロールバック。
3. `PageLike` 型（crawler.ts:18 で `click` を既に定義）にクリック API を利用。
4. 破壊的アクション回避: `isLogout` に加え delete/destroy/remove/submit 相当のラベル・URL を除外。
   （読み取り専用の遷移のみ観測、副作用のあるボタンは踏まない。）
5. 可視化: どのボタンから遷移したかをレポートに残す（report.ts の activity 要約）。
6. 検証: roomport admin で discovered ページ数が href-only 時より増えることを確認。

### 影響/リスク

- クリック探索はページごとに N クリック分の往復が増え、crawl 時間が伸びる。
  → maxPages/maxDepth と、1 ページあたりクリック候補上限を設けて抑制。
- 副作用のあるボタンを誤って踏むリスク → 除外ガードを厳格化（成功パターン観測のみが方針）。
- SPA の history 遷移は `goto` ロールバックで状態が壊れる可能性 → `goBack` 優先 + 失敗時 `goto`。

---

## Fix 4: crawl 到達ページ数を 10 まで増やす（現状 2）

### 根拠 (Evidence)

「Crawl complete pageCount 2」ログの出所は `collect` パイプラインの `crawlWithBrowser`:

```
collect.ts:112   ? await crawl(browser, target, deps.scenarios ?? [], screenshotDir)
collect.ts:114   logger.info({ pageCount: rawPages.length }, 'Crawl complete')
```

`crawlWithBrowser` (`crawler.ts:142`) の到達範囲は **base URL + シナリオの遷移 target のみ**で、
**BFS もリンク発見も maxPages も無い**:

```
crawler.ts:154   const page = await browser.newPage()
crawler.ts:168   const basePage = await capturePage(page, target.baseUrl, ...)   ← 1枚目
crawler.ts:173-195  for (scenario) for (step) if(isNavigationTarget) capturePage  ← シナリオ遷移のみ
```

- つまり `pageCount 2` = base(1) + シナリオ遷移(1)。ページ数を増やす knob が collect 側に無い。
- 一方、BFS + `maxPages`/`maxDepth` を持つのは **`grow` の `discoverPages`**:
  ```
  discover.ts:28   while (queue.length > 0 && results.length < opts.maxPages)
  schema.ts:78     maxPages: z.number().int().positive().default(50)
  ```
  roomport の `e2e.config.yaml` は `grow.maxPages: 15` に設定済みだが、これは grow 経路にしか効かない。
- よって「pageCount=10 まで増やす」には、**どの経路のページ数か**を明確化する必要がある。

### 対策（2 案。推奨は A）

**案 A（推奨）: `collect` に BFS discovery を組み込む**
- `collect` が `crawlWithBrowser`（base+scenario）に加えて `discoverPages` を使い、
  同一の認証済みページから BFS で到達ページを増やす。到達上限は config で制御。
- Fix 3 のボタン押下探索もこの discovery に載るため、3 と 4 を同一経路で満たせる。
- config に `crawl.maxPages`（もしくは既存 `grow.maxPages` の共有）を設け、既定を 10 に。

**案 B（最小変更）: シナリオを増やす**
- `crawlWithBrowser` はシナリオ遷移を辿るので、遷移 target を持つシナリオを 8+ 追加すれば
  pageCount は増える。ただし手動シナリオ作成が前提で、発見の自動性は上がらない。

### タスク（案 A）

1. `config/schema.ts` に crawl 到達上限を追加（または `grow.maxPages` を collect でも参照）。
   既定値 10。roomport は必要に応じ上書き。
2. `collect.ts` の crawl 呼び出しを拡張: `crawlWithBrowser` の結果に `discoverPages` の
   結果を URL 重複排除してマージ（`crawlWithBrowser` 内 `visitedUrls` と同ロジック）。
3. discovery は既存の認証済み page / 共有 context を再利用（`skipLogin` 経路）。
4. `pageCount` ログはマージ後の枚数を出す。
5. 検証: roomport で `Crawl complete pageCount >= 10` を確認し、transactions が増えること。

### 影響/リスク

- crawl 時間増（Fix 3 と同様、上限で抑制）。
- 案 A は collect と grow の discovery を統合するリファクタを伴うため、grow 側の回帰に注意。
  最小で始めるなら案 B → 効果を見て案 A に移行も可。

---

## 実装順序（推奨）

1. **Fix 1**（最小・独立・症状①を即解消） → viewer にルートが出るようになる。
2. **Fix 2**（小修正・独立・症状②の主要因） → CRUD 通信が記録される。
3. **Fix 4 案 A**（collect に discovery 統合の土台） → 到達ページ増。
4. **Fix 3**（4 の discovery 経路にボタン押下探索を追加） → JS 遷移も観測。

Fix 1/2 は互いに独立で並行可能。Fix 3 は Fix 4 案 A の discovery 経路に載せると効率的。

## 検証方法（共通）

roomport (`/Users/go/work/hosty/roomport/e2e.config.yaml`) を対象に:

1. `analyze` → `data/unified.json` 生成を確認（Fix 1）。
2. `crud` 再実行 → `behavior.transactions.jsonl` の行数増 + POST/PATCH/DELETE 記録（Fix 2）。
3. crawl/grow → `Crawl complete pageCount >= 10`（Fix 4）。
4. discovered ページに href 無し（ボタン起点）画面が含まれる（Fix 3）。
5. viewer 起動 → ルート表示 + 通信ログが増えていること。

## 関連ファイル一覧（変更対象）

| Fix | ファイル | 箇所 |
|-----|----------|------|
| 1 | `packages/cli/src/index.ts` | `cmdAnalyze` L178-181 に `await cmdReconcile()` 追加 |
| 2 | `packages/behavior/src/cli/commands/crud.ts` | L121 前後に recorder 生成 + `withRecorder` |
| 3 | `packages/behavior/src/services/browser/discover.ts` | `extractLinks` L74-88 + クリック探索追加 |
| 4 | `packages/behavior/src/pipeline/collect.ts` / `config/schema.ts` | crawl に discovery 統合 + maxPages |
