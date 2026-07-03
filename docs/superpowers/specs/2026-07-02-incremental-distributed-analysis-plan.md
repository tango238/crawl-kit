# 実装計画: 差分・分散・段階的詳細化アナライザ (structure + e2e 計画解析)

- 日付: 2026-07-02
- 対象: crawl-kit `packages/structure`（＋`packages/behavior` の CRUD/e2e 計画導出、`packages/contract` の鮮度ストア）
- 動機: roomport（Laravel 250テーブル/297ルート）で `analyze-structure` が **1回の agentic claude で全リポを直列に舐める**ため 30分でもタイムアウト。差分・並列・段階化で「少しずつ・速く・詳細化」できるようにする。

## 現状（実地で確認した事実）

- `analyzeRepo(repo)`（`structure/src/analyze/index.ts`）= SourceParser（routes/controllers/models/pages を **whole-repo の agentic claude** で抽出, `--max-turns 100`）→ UseCaseExtractor（routes+controllers、`maxRoutes` 既定200）→ InformationModelGenerator → route-events。結果を `data/structure.*.json` に書く。
- 鮮度: `acquisition.json`（`contract`）が **ディレクトリ単位**のハッシュを記録。`analyze-structure` は「どこか変わったら**全部**再解析」する粗い gate。
- LLM: `USE_CLAUDE_CODE`→`claude` を execFile（1ステージ=1プロセス、`analyzeTimeout` 既定600s）。並列度は `makeLimiter(resolveClaudeCodeConcurrency)` で既に上限管理あり。
- 問題: (1) 巨大リポで1ステージが重くタイムアウト、(2) 差分が dir-gate 止まりで**部分再解析できない**、(3) **並列ファンアウト無し**、(4) 段階（粗→細）が無く、e2e 計画に必要な「ルート一覧」が出るまで全解析の完了を待つ。

## ゴール

1. **分散（並列ファンアウト）**: 解析単位（route ファイル/モジュール）ごとに独立解析し、`makeLimiter` で束ねて並行実行。1単位は小さく高速・タイムアウトしない。
2. **差分更新**: 単位×パス粒度でハッシュ管理し、**変わった単位のパスだけ**再解析。未変更はキャッシュ断片を再利用。
3. **同期ポイント**: 断片をマージする段（重複排除・跨ぎ解決）をバリアとして置く。
4. **段階的詳細化（progressive）**: 粗いルート一覧（Pass1）→ 詳細（entity/CRUD/events, Pass2）→ 跨ぎ（情報モデル/UC/gap, Pass3）。Pass1 完了時点で **e2e/CRUD 計画の骨子が使える**。

## アーキテクチャ

```
plan（単位棚卸し＋差分判定）
  └─ units[] = {id, files[], hash, prevHash, dirtyPasses[]}
        │  fan-out（makeLimiter, per-unit scoped agentic claude）
        ▼
Pass1 粗: 各単位 → RouteInventory 断片（method+path+controller）
   └─(sync: merge/dedup by normalizeRoute)→ data/structure.routes.partial.json ← e2e/CRUD 計画はここから開始可能
        │
        ▼
Pass2 細: 変更単位 → route→entity/CRUD/events, controller request-rules, model attrs 断片
   └─(sync: cross-unit 解決 route→controller→model)→ structure.nodes.json 詳細化
        │
        ▼
Pass3 跨ぎ: information-model / usecase 群 / CRUD gap（全断片を入力）
   └─ data/structure.rdra.json / *.mmd
        │
        ▼
差分ストア更新: acquisition.json を {unit:{hash, passHashes}} 粒度に拡張（次回は dirty 単位×パスのみ）
```

- **キャッシュ**: 断片を `.crawl-kit-cache/fragments/<unitId>-<hash>-<pass>.json` に保存。未変更単位・同一ハッシュはキャッシュ再利用（差分の実体）。
- **オーケストレーション**: crawl-kit 内部の並行（`makeLimiter`）で実装（Workflow ツール非依存＝CI でも動く）。将来 Workflow 連携も可能。

## ファイル構成（新規/変更）

- Create: `packages/structure/src/analyze/units.ts` — 解析単位の列挙＋per-unit ハッシュ（routes/*.php, app/Http/Controllers/<dir>, app/Models 等をフレームワーク別に）。
- Create: `packages/structure/src/analyze/scoped-parser.ts` — 単位スコープの agentic 解析（対象ファイルのみを prompt/cwd 制約で渡す）→ 断片。
- Create: `packages/structure/src/analyze/fragments.ts` — 断片型＋キャッシュ read/write（unitId×hash×pass）。
- Create: `packages/structure/src/analyze/merge.ts` — 断片マージ（route dedup=normalizeRoute、entity 統合、route→controller→model 跨ぎ解決）。
- Create: `packages/structure/src/analyze/passes.ts` — Pass1/2/3 の定義とファンアウト＋sync 実行。
- Modify: `packages/structure/src/analyze/index.ts` — `analyzeRepo` を passes 駆動に。部分結果を逐次 emit。
- Modify: `packages/contract/src/`（acquisition/freshness）— 単位×パス粒度のハッシュストアへ拡張（後方互換: 旧 dir-gate はフォールバック）。
- Modify: `packages/cli/src/index.ts` — `analyze-structure` に `--incremental`(既定 on)/`--pass <1|2|3>`/`--unit <glob>`/`--force`；Pass1 完了で即 routes を書く。
- Modify: `packages/behavior`（CRUD/e2e 計画）— `buildCrudPlans` 等が **Pass1 の routes.partial** を入力に取れるように（詳細は Pass2 で後追い上書き）。
- Tests: units / scoped-parser（LLM はフェイク注入）/ fragments キャッシュ / merge dedup・跨ぎ / passes 差分スキップ / freshness 単位粒度。

## タスク（TDD・各末尾コミット）

### Task 1: 解析単位の列挙＋ハッシュ（`units.ts`）
- Produces `enumerateUnits(repo, frameworks): Unit[]`（`{id, files[], hash}`）。framework 検出（既存 `detectFrameworks`）で Laravel: `routes/*.php`＋`app/Http/Controllers/**`＋`app/Models/**`、Next: `app/**/route.ts` 等に分割。
- ハッシュは既存 `util/hash` 相当（内容ハッシュ）。
- Test: フェイク FS で単位分割とハッシュ安定性。

### Task 2: 断片型＋キャッシュ（`fragments.ts`）
- `StructureFragment = { unitId; pass; routes[]; entities[]; controllers[]; refs[] }`。
- `readFragment(unitId,hash,pass)` / `writeFragment(...)`（`.crawl-kit-cache/fragments/`）。
- Test: write→read ラウンドトリップ、ミスでnull。

### Task 3: 単位スコープ解析（`scoped-parser.ts`）
- `parseUnit(unit, pass, llm): StructureFragment`。pass1=ルート一覧のみ（軽prompt・低turn）、pass2=entity/CRUD/events。LLM は注入（フェイクでテスト）。
- `claude` 呼び出しは対象ファイルに限定（cwd=repo だが prompt に files を明示、`--max-turns` を pass 別に小さく）。
- Test: フェイク LLM 応答→断片へパース。

### Task 4: マージ／同期（`merge.ts`）
- `mergeFragments(frags[]): StructureModel`。route を `normalizeRoute` で dedup、entity 統合、`route→controller→model` 参照解決。
- Test: 重複ルート統合、跨ぎ解決、部分入力でも壊れない。

### Task 5: パス駆動＋差分（`passes.ts` ＋ freshness 拡張）
- `runPasses(repo, opts, deps)`: units 列挙→dirty 判定（unit×pass ハッシュ）→ `makeLimiter` で dirty 単位を並列 `parseUnit`→ 各 pass 末で `mergeFragments`→ emit→ ハッシュ記録。
- 未変更単位はキャッシュ断片を使う（差分更新）。
- Test: 2回目実行で dirty のみ再解析（フェイクLLM呼び出し回数で検証）。

### Task 6: analyzeRepo を passes 化（`index.ts`）
- `analyzeRepo` を `runPasses` に置換。Pass1 完了時点で `structure.routes.partial.json` を書き、Pass2/3 で詳細化。既存 emit 形式（structure.nodes.json 等）は維持。
- Test: 既存 analyze.test 互換＋段階出力。

### Task 7: CLI 段階/差分オプション（`cli`）
- `analyze-structure [--incremental] [--pass N] [--unit <glob>] [--force]`。進捗を単位/パス単位でログ。Pass1 で routes 即時利用可。
- Test: 引数パース＋部分実行。

### Task 8: e2e/CRUD 計画が部分 structure を消費（`behavior`）
- `buildCrudPlans` 等が `structure.routes.partial.json`（Pass1）でも動くよう入力を緩め、Pass2 の詳細で上書き再導出。
- Test: 部分入力→計画、詳細入力→詳細計画。

### Task 9: 全体ビルド＋テスト緑＋ docs（OPERATIONS に運用追記）

## 期待効果
- roomport 級でも **Pass1（ルート一覧）が数分で出て e2e/CRUD 計画に着手**でき、詳細は後追いで埋まる。
- 2回目以降は **変更した route ファイル/コントローラだけ**再解析（差分）→ 桁違いに速い。
- タイムアウトは単位が小さいので構造的に回避。

## 未確定（実装時に決める）
- 単位粒度（ファイル vs ディレクトリ vs bounded-context）。まずファイル/ディレクトリで開始。
- キャッシュ無効化ポリシー（プロンプト/モデル変更時のバージョンキー）。
- Pass1 の「ルートのみ」を LLM でなく決定的パーサ（Laravel `Route::` 正規表現＋グループ prefix 解決）で出す高速版の併設（LLM フォールバック付き）。
