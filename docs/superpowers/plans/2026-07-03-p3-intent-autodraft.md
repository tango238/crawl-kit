# P3: intent 自動ドラフト + 集約 + 集約×エンティティマッピング Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `run` の intent フェーズが intent.json 不在時に LLM でドラフトを自動生成し、集約一覧（intent.aggregates.json）と集約×エンティティ相関（mapping.aggregate-entity.json）を成果物として出す。

**Architecture / スペックからの設計修正（重要）:** 調査の結果、distill-ddd は**独立 CLI ではなく Claude スキル（/ddd）**であり、`emit_intent.py` が `docs/domain/intent.json` を出す構成だった。よってスペック D 節の「distill-ddd の --analyze 相当を非対話実行」は成立しない。ADR-0002（contract-only 連携）に沿い、**crawl-kit 自身が LLM プロバイダ（structure と同じ getProvider 系）で intent.json 契約形式のドラフトを生成**する。distill-ddd（/ddd スキル）は精緻化の正道としてガイダンスに案内する。doctor の distill-ddd CLI 検出は「intent ソース検査」（intent.json 存在 or LLM プロバイダ利用可）に置き換える。集約×エンティティ相関は LLM 一発ではなく **reconciler の unified.json から機械導出**し、未マッチのエンティティのみ名前類似ヒューリスティック（+ evidence/confidence）で補完する。

**Tech Stack:** TypeScript (ESM, Node>=20), zod, Vitest

**親スペック:** `docs/superpowers/specs/2026-07-03-workspace-unified-pipeline-design.md` D 節

## Global Constraints

- ESM / `.js` 拡張子 import。intent/reconciler はファイルの既存スタイルに合わせる（セミコロン有無を確認）。cli はセミコロンあり
- console.log は cli の cmd* のみ。intent/reconciler の新モジュールは純粋・無音
- イミュータブル。進捗台帳は P1 純関数経由
- TDD（RED→GREEN）。コミットメッセージは各タスク指定
- LLM 依存は**構造的型**で受ける: intent パッケージに `type DraftLlm = { completeSimple(userMessage: string, systemPrompt?: string, maxTokens?: number): Promise<string> }` を定義し、structure の `LlmProvider` を cli 側で渡す（intent→structure のパッケージ依存を作らない）
- LLM なしでも全パイプラインが壊れないこと（intent: blocked、mapping: ヒューリスティックのみで生成）

---

### Task 1: contract + intent — 集約導出（deriveAggregates）と DATA_FILES 追加

**Files:**
- Modify: `packages/contract/src/paths.ts`（DATA_FILES に `intentAggregates: "intent.aggregates.json"`, `aggregateEntityMapping: "mapping.aggregate-entity.json"` を追加）
- Create: `packages/intent/src/aggregates.ts`
- Modify: `packages/intent/src/index.ts`（export 追加）
- Test: `packages/intent/src/aggregates.test.ts`

**Interfaces:**
- Produces:
  - `type AggregateDoc = { aggregates: Array<{ conceptId: string; name: string; members: Array<{ conceptId: string; name: string; via: "dependsOn" | "event" | "self" }> }> }`
  - `deriveAggregates(glossary: Glossary): AggregateDoc` — 純関数:
    - aggregates = `concepts.filter(c => c.kind === "aggregate-root")`。conceptId は emit.ts と同じ規則（`concept:<slugify(name)>` — 既存 `aggregateConceptId`/slugify を再利用 or export）
    - members: ①集約自身（via "self"）②`dependsOn` に集約名を含む concept（via "dependsOn"）③`events[].aggregate === 集約名` の event の `consumer`/`trigger` は含めない — event 経由の membership は「その集約名を `aggregate` に持つ event の名前」ではなく **concept のみ**を対象とし、`glossary.events` から集約に紐づく concept 名が `properties` に現れても無視（YAGNI: dependsOn と self のみで開始し、via "event" は `events[].aggregate` が指す集約に、event 名そのものではなく該当 event を発する concept があれば付ける — 実装単純化のため **members は self + dependsOn のみ**とし、via "event" は型に残すが未使用でよい。テストもその前提で書く）
- テスト観点: aggregate-root 2 つ + dependsOn で片方にぶら下がる entity 2 つ → members が正しく分かれる。kind なし concept は集約にならない。dependsOn が存在しない名前を指しても落ちない（無視）。

- [ ] Step 1: 失敗するテスト → Step 2: RED 確認（`cd packages/intent && pnpm vitest run`）→ Step 3: 実装 → Step 4: GREEN + `pnpm lint` → Step 5: コミット `feat(intent): derive aggregates doc from the glossary`

---

### Task 2: intent — LLM ドラフト生成（draftGlossary）

**Files:**
- Create: `packages/intent/src/draft.ts`
- Create: `packages/intent/src/glossary-schema.ts`（Glossary の zod スキーマ。既存 TS 型と一致させる。intent に zod 依存を追加 — contract と同じ ^3.24 系）
- Modify: `packages/intent/src/index.ts` / `packages/intent/package.json`
- Test: `packages/intent/src/draft.test.ts`

**Interfaces:**
- Produces:
  - `GlossarySchema`（zod。`concepts[].name`/`attributes` 必須、他は optional — model.ts と同形）
  - `type DraftLlm = { completeSimple(userMessage: string, systemPrompt?: string, maxTokens?: number): Promise<string> }`
  - `type DraftInput = { repoNotes: Array<{ name: string; framework: string; structureSummary: string }>; entityNames?: string[]; routeSummaries?: string[] }`（cli が repos/<name>.yaml と structure 成果物から組み立てる）
  - `draftGlossary(input: DraftInput, llm: DraftLlm): Promise<Glossary>`:
    - プロンプト（日本語）: 「以下のシステム情報から DDD の観点でドメインモデルのドラフトを JSON で出力せよ。イベントは過去形、集約は aggregate-root…」+ 期待 JSON 形（GlossarySchema の形を明記）+ 「JSON のみを出力」
    - 応答から最初の `{`〜最後の `}` を抜き出して JSON.parse → GlossarySchema.parse。失敗したら**1 回だけ**「前回の応答は不正だった。JSON のみを返せ」で再試行。2 回目も失敗なら throw（呼び出し側が blocked にする）
- テスト: fake llm（固定 JSON 返却）で Glossary が返る／不正 JSON→再試行で成功／2 連続不正→throw／余計な前置き文付き応答から JSON 抽出できる。

- [ ] Step 1-5: TDD → コミット `feat(intent): LLM glossary draft with schema validation and one retry`

---

### Task 3: reconciler — 集約×エンティティマッピング導出

**Files:**
- Create: `packages/reconciler/src/aggregate-mapping.ts`
- Modify: `packages/reconciler/src/index.ts`
- Test: `packages/reconciler/src/aggregate-mapping.test.ts`

**Interfaces:**
- Consumes: `Unified` / `UnifiedConcept`（contract）、`AggregateDoc`（intent — reconciler は既に contract 依存。intent への依存追加を避けるため **AggregateDoc は構造的に受ける**: 引数型をローカルに定義し shape 一致で受容）
- Produces:
  - `type AggregateEntityMapping = { generatedAt: string; aggregates: Array<{ conceptId: string; name: string; entities: Array<{ nodeId: string; entity: string; repo?: string; confidence: number; evidence: string }> }>; unassigned: Array<{ nodeId: string; entity: string; repo?: string }> }`
  - `deriveAggregateEntityMapping(unified: Unified, aggregates: AggregateDocLike, opts?: { now?: string }): AggregateEntityMapping` — 純関数:
    1. membership 索引: aggregateConceptId → member conceptIds（AggregateDoc から）
    2. unified.concepts を走査: `structure` LayerNode のうち `nodeId.startsWith("structure:entity/")` のものを、その concept の所属集約に割当（concept が集約自身なら confidence 0.95 / evidence "reconciled to aggregate root"; member 経由なら 0.85 / "reconciled to member <name>"）
    3. どの集約にも属さない structure エンティティ（コード限定 concept 等）: 集約名・member 名との **名前類似**（slug 完全一致 → 0.6 "name match"; 片方が他方を含む → 0.4 "partial name match"）で最良の集約へ。それ未満は `unassigned`
    4. LayerNode に repo タグ（P2 で付与）があれば `repo` に転記（`(node as { repo?: string }).repo` で安全に読む）
- テスト: 集約直付き／member 経由／名前一致で救済／unassigned に落ちる、の 4 系統 + 空 unified で空出力。

- [ ] Step 1-5: TDD → コミット `feat(reconciler): derive aggregate-entity mapping from unified + aggregates`

---

### Task 4: cli — intent フェーズ強化（ドラフト生成 + 集約出力）と doctor の intent ソース検査

**Files:**
- Modify: `packages/cli/src/commands/run-phases.ts`（intentPhase）
- Modify: `packages/cli/src/commands/doctor.ts`（distill-ddd チェック → intent ソースチェック）
- Modify: `packages/cli/src/index.ts`（RunDeps に `draftIntent?` を実装して渡す）
- Test: `packages/cli/src/commands/run-phases.test.ts`（追記）、`packages/cli/src/commands/doctor.test.ts`（修正）

**Interfaces:**
- `RunDeps` に追加: `draftIntent?: (root: string) => Promise<Glossary | null>`（null = プロバイダなし等で不可）。**既存フィールドは不変**
- intentPhase の新フロー:
  1. `docs/domain/intent.json` があれば従来どおり読み込み → emit（変更なし。壊れていれば blocked 理由は現行の「読み込みに失敗」）
  2. なければ `deps.draftIntent?.(root)` を試す。Glossary が返れば **`docs/domain/intent.json` に書き出し**（次回以降は 1 のパス。/ddd で精緻化できるよう soulce of truth をファイルに残す）→ emit。tasks は 2/2（draft + emit）
  3. draftIntent が無い/null/throw → blocked 理由「intent.json なし、LLM プロバイダも未設定 — /ddd（distill-ddd）で作成するか ANTHROPIC_API_KEY / USE_CLAUDE_CODE を設定してください」
  4. emit 後、`deriveAggregates(glossary)` を `data/intent.aggregates.json`（DATA_FILES.intentAggregates）へ書く（1・2 どちらのパスでも）
- index.ts の `draftIntent` 実装: `getProvider()` が null なら null を返す。非 null なら `DraftInput` を組み立て（`.crawl-kit/repos/*.yaml` の framework/structure.summary + `data/structure.rdra.json` があれば entity 名 + `data/structure.routes.partial.json` があれば route path 上位 50 件）て `draftGlossary` を呼ぶ
- doctor 変更: `distill-ddd` チェック（id はそのまま or `intent-source` に改名可）の ok 条件を「`docs/domain/intent.json` 存在 or `which("distill-ddd")` or **LLM プロバイダ検出**（`USE_CLAUDE_CODE` truthy or `ANTHROPIC_API_KEY` 非空）」に拡張。fixHint に上記 3 手段を列挙。既存テスト（intent.json 存在で ok）は生かし、「プロバイダ env だけで ok になる」テストを追加
- run-phases テスト追記: draft 成功パス（fake draftIntent が Glossary を返す → intent.json が書かれ、nodes と aggregates が出る、tasks 2/2）／draft 不可 → blocked 理由に「LLM プロバイダ」を含む／既存 intent.json パスでも aggregates が書かれる

- [ ] Step 1-5: TDD → コミット `feat(cli): intent auto-draft + aggregates emission + intent-source doctor check`

---

### Task 5: cli — reconcile フェーズでマッピング出力

**Files:**
- Modify: `packages/cli/src/index.ts`（cmdReconcile の末尾でマッピング導出・書き出し）
- Test: 変更は cmdReconcile 内のため、`packages/cli` に統合テストを 1 本（fixture の unified/aggregates を data/ に置いて cmdReconcile 相当を叩く…が cmdReconcile は非公開。**実装方針**: マッピング書き出しを小関数 `writeAggregateMapping(dataDir?: ...)` として `packages/cli/src/commands/aggregate-mapping-io.ts` に切り出し、cmdReconcile から呼ぶ。テストはこの小関数に対して行う）

**Interfaces:**
- `writeAggregateMapping(): Promise<{ written: boolean; aggregates: number; unassigned: number }>` — `data/unified.json` と `data/intent.aggregates.json` の**両方があるときのみ** `deriveAggregateEntityMapping` を実行して `data/mapping.aggregate-entity.json` を書く。どちらか欠けたら `{ written: false, ... }`（黙ってスキップ — intent 未対応でも reconcile は従来どおり動く）
- cmdReconcile 末尾に `const m = await writeAggregateMapping(); if (m.written) console.log(...)` を追加

- [ ] Step 1-5: TDD（temp workspace に fixture を置いて written true/false 両方）→ コミット `feat(cli): emit aggregate-entity mapping after reconcile`

---

### Task 6: 全体検証 + スモーク + README

- [ ] Step 1: `pnpm -r lint && pnpm -r test && pnpm --filter @tanago3/crawl-kit build`
- [ ] Step 2: スモーク（scratch workspace、P2 Task 7 の手順をベースに）:
  - (a) intent.json **あり**（aggregate-root 1 つ + dependsOn entity 1 つ + events/stateTransitions 最小）で `run --no-viewer --only intent` → `data/intent.nodes.json` + `data/intent.aggregates.json` が生成され progress.intent completed
  - (b) intent.json **なし** + プロバイダ env なし → intent blocked、理由に「LLM プロバイダ」— ledger で確認
  - (c) フル `run --no-viewer`（intent.json あり）→ reconcile 後に `data/mapping.aggregate-entity.json` が生成される（unified + aggregates が揃うため）
  - LLM 実呼び出しのドラフト生成はスモーク対象外（プロバイダ env に依存するため。fake での単体テスト済み）
- [ ] Step 3: README — intent 自動ドラフトの説明（distill-ddd/ddd スキルとの関係、プロバイダ env）、成果物一覧に 2 ファイル追記。スペック D 節に「設計修正」注記を追記（本プラン冒頭の Architecture 段落を要約）
- [ ] Step 4: コミット `docs: intent auto-draft + aggregate mapping usage`

---

## Self-Review 結果

- **スペック D 節網羅**: D-1 検出/案内 → Task 4 doctor。D-2 TTL 内再利用 → 既存 intentPhase の TTL gate（P2）で担保。D-3 emit → 既存。D-4 aggregates → Task 1+4。D-5 mapping（confidence+evidence 付き） → Task 3+5。「distill-ddd 非対話実行」はスキル実態に合わせ設計修正（冒頭に明記、スペックにも注記を Task 6 で反映）。
- **型整合**: `DraftLlm`/`DraftInput`/`Glossary`（Task 2）↔ Task 4 の draftIntent。`AggregateDoc`（Task 1）↔ Task 3 の構造的受容 ↔ Task 4 の書き出し。`AggregateEntityMapping`（Task 3）↔ Task 5。
- **順序**: Task 1 → 2/3 並列可 → 4 → 5 → 6。LLM なし環境でも (b)(c) が成立する設計。
