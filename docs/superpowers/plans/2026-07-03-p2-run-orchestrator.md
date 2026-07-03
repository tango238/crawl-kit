# P2: `run` オーケストレータ（resume / clear / viewer自動起動 / タスクカウント / 並列上限） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `crawl-kit run` をワークスペース対応の統合コマンドに再定義する: preflight → viewer起動 → intent → structure（マルチリポ・タスクカウント）→ reconcile → behavior → reconcile → verify を進捗台帳に記録しながら実行し、中断後の再開・`clear` による全消去を可能にする。

**Architecture:** 新しい `packages/cli/src/commands/run.ts` がオーケストレータ。P1 の progress ledger（contract）・runDoctor/blockedPhases（cli）・loadWorkspaceConfig（behavior）を組み合わせる。structure の pass エンジンに unit 単位の進捗フック `onUnit` を追加、behavior の `loadConfig` に workspace.yaml フォールバックを追加。viewer サーバは `serve.ts` に抽出して run から再利用。

**Tech Stack:** TypeScript (ESM, Node>=20), zod, Vitest, esbuild

**親スペック:** `docs/superpowers/specs/2026-07-03-workspace-unified-pipeline-design.md`（C 節が本体、E 節のマルチリポ対応もここで実装）

## Global Constraints

- ESM / imports は `.js` 拡張子付き。cli パッケージはセミコロンあり、behavior/structure はセミコロンなし — 各ファイルの既存スタイルに合わせる
- console.log は CLI コマンドハンドラ（cmd*）のみ。ライブラリ・ヘルパーは禁止
- **イミュータブル**: progress 更新は P1 の純関数（withPhaseStatus 等）経由のみ
- TDD: 失敗するテスト → 実装。コミットメッセージは各タスク指定のものを使用
- 進捗台帳の書き込みは必ず `writeProgress`（atomic）
- P1 で確立した既存インターフェースのシグネチャを変えない（`runDoctor` / `blockedPhases` / `loadWorkspaceConfig` / progress 純関数群）
- 既存の非ワークスペース運用（`run <repo>` / `analyze` / `analyze-structure`）の挙動を壊さない
- テスト: パッケージ dir で `pnpm vitest run <file>`、コミット前にパッケージ全体、Task 7 でモノレポ全体
- ソース変更後に依存パッケージの dist が古い場合は `pnpm build`（contract/behavior/structure → cli の順）

---

### Task 1: structure — pass エンジンに unit 単位の進捗フック `onUnit`

**Files:**
- Modify: `packages/structure/src/analyze/passes.ts`
- Modify: `packages/structure/src/analyze/incremental.ts`
- Test: `packages/structure/src/analyze/passes.test.ts`（既存に追記。無ければ incremental のテストファイルに追記 — 実装時に既存テストの場所を `ls packages/structure/src/analyze/*.test.ts` で確認して合わせる）

**Interfaces:**
- Consumes: `RunPassesDeps`（passes.ts:27）に既にある `onPass?: (pass, merged, units) => void | Promise<void>`（passes.ts:39）と、per-unit の fan-out ループ（`runPasses` 内部）
- Produces:
  - `RunPassesDeps.onUnit?: (pass: number, unitId: string, index: number, total: number) => void | Promise<void>` — **各 unit のフラグメントが確定した時点**（キャッシュヒットでもパース完了でも）に、pass ごとに 1 unit につき 1 回呼ばれる。`index` は 1 始まりの完了数、`total` はその pass の unit 総数
  - `IncrementalOptions.onUnit?: 同シグネチャ`（incremental.ts:22 の interface に追加し、`runPasses` の deps へそのまま渡す）

- [ ] **Step 1: 失敗するテストを書く**

既存の passes/incremental テストのパターン（fake parse / enumerate 注入）に合わせて追記する。テストの骨子（既存テストの fixture 流儀に適合させること）:

```typescript
it("onUnit fires once per unit per pass with 1-based completion index", async () => {
  const calls: Array<{ pass: number; unitId: string; index: number; total: number }> = []
  // 既存テストと同じ fake enumerate（2 unit）+ fake parse を使い、passes [1, 2] で実行
  await runPasses(repoPath, { passes: [1, 2], context: "" }, {
    llm: null,
    enumerate: fakeEnumerateTwoUnits,
    parse: fakeParse,
    cacheDir,
    onUnit: (pass, unitId, index, total) => { calls.push({ pass, unitId, index, total }) },
  })
  expect(calls).toHaveLength(4) // 2 units × 2 passes
  expect(calls.filter(c => c.pass === 1).map(c => c.index).sort()).toEqual([1, 2])
  expect(calls.every(c => c.total === 2)).toBe(true)
})
```

- [ ] **Step 2: RED 確認** — Run: `cd packages/structure && pnpm vitest run src/analyze/` Expected: FAIL（onUnit が未定義プロパティ）

- [ ] **Step 3: 実装**

`passes.ts`: `RunPassesDeps` に `onUnit?` を追加。`runPasses` の per-unit 処理（fan-out ループ内、fragment 確定直後）で完了カウンタをインクリメントして `await deps.onUnit?.(pass, unit.id, ++done, units.length)` を呼ぶ。並行実行下でもカウンタは単調増加であること（fan-out が Promise.all 型なら、完了順のカウンタをクロージャで持つ）。
`incremental.ts`: `IncrementalOptions.onUnit?` を追加し、`runPasses(..., { ..., onUnit: options.onUnit })` で通す。

- [ ] **Step 4: GREEN 確認** — Run: `cd packages/structure && pnpm vitest run` Expected: 全パス（既存 82 + 新規）

- [ ] **Step 5: コミット**

```bash
git add packages/structure/src/analyze/passes.ts packages/structure/src/analyze/incremental.ts packages/structure/src/analyze/*.test.ts
git commit -m "feat(structure): per-unit progress hook (onUnit) in the pass engine"
```

---

### Task 2: behavior — `loadConfig` の workspace.yaml フォールバック

**Files:**
- Modify: `packages/behavior/src/config/load.ts`
- Test: `packages/behavior/src/config/load.test.ts`（追記）

**Interfaces:**
- Consumes: 既存 `loadConfig(root)`（e2e.config.yaml、missing env で throw）、`loadWorkspaceConfig(root)`（P1）、`WORKSPACE_CONFIG_RELPATH`
- Produces: `loadConfig(root)` の挙動拡張 — **root に e2e.config.yaml が無く、`.crawl-kit/workspace.yaml` がある場合**、workspace 設定を読み Config 互換に射影して返す（シグネチャ・throw 契約は不変）:
  - `github` が無ければ `{ labels: { ready: "ready", autoDetect: "auto-detect" } }` で補完
  - missing env は従来どおり throw（loadConfig の契約維持）
  - e2e.config.yaml が存在する場合の挙動はバイト単位で従来どおり
  - これにより behavior CLI（loop-e2e）の全コマンドが workspace root を cwd にして動く

- [ ] **Step 1: 失敗するテストを書く**（load.test.ts 追記）

```typescript
describe('loadConfig workspace fallback', () => {
  it('falls back to .crawl-kit/workspace.yaml when e2e.config.yaml is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ck-fb-'))
    await mkdir(join(root, '.crawl-kit'), { recursive: true })
    await writeFile(join(root, '.crawl-kit', 'workspace.yaml'), [
      'repositories:',
      '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
    ].join('\n'), 'utf8')
    const { config } = await loadConfig(root)
    expect(config.github.labels.ready).toBe('ready') // 補完される
    expect(config.scenarioDir).toBe('scenarios')
  })

  it('still throws on missing env vars in workspace fallback mode', async () => {
    delete process.env['CK_FB_PW']
    const root = await mkdtemp(join(tmpdir(), 'ck-fb2-'))
    await mkdir(join(root, '.crawl-kit'), { recursive: true })
    await writeFile(join(root, '.crawl-kit', 'workspace.yaml'), [
      'repositories:',
      '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
      'databases:',
      '  - { name: m, type: postgres, host: h, port: 5432, database: d, user: u, passwordEnv: CK_FB_PW }',
    ].join('\n'), 'utf8')
    await expect(loadConfig(root)).rejects.toThrow(/CK_FB_PW/)
  })

  it('prefers e2e.config.yaml when both exist', async () => {
    // 既存の loadConfig テストの最小 e2e.config.yaml fixture を流用し、
    // workspace.yaml も並置したうえで e2e.config.yaml 側の値（例: scenarioDir）が勝つことを確認する
  })
})
```

（3 つ目のテストは既存 fixture の形に合わせて具体化。既存 load.test.ts の e2e.config.yaml fixture をコピーして使う。）

- [ ] **Step 2: RED 確認** — Run: `cd packages/behavior && pnpm vitest run src/config/load.test.ts` Expected: FAIL

- [ ] **Step 3: 実装**（load.ts）

```typescript
import { existsSync } from 'node:fs'

const GITHUB_DEFAULT = { labels: { ready: 'ready', autoDetect: 'auto-detect' } }

export async function loadConfig(root: string): Promise<{ config: Config; secrets: Secrets }> {
  dotenv.config({ path: join(root, '.env'), quiet: true })
  if (!existsSync(join(root, CONFIG_FILENAME)) && existsSync(join(root, WORKSPACE_CONFIG_RELPATH))) {
    const { config: ws, secrets, missingEnv } = await loadWorkspaceConfig(root)
    if (missingEnv.length > 0) {
      throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`)
    }
    const config: Config = { ...ws, github: ws.github ?? GITHUB_DEFAULT }
    return { config, secrets }
  }
  const raw = await readYaml<unknown>(join(root, CONFIG_FILENAME))
  const config = ConfigSchema.parse(raw)
  const { secrets, missing } = resolveSecrets(config)
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
  return { config, secrets }
}
```

型注意: `WorkspaceConfig` は `Config` のスーパーセット（github が optional な点だけ差）なので、github 補完後は `Config` に代入可能。tsc が拒む場合は `ConfigSchema.parse({ ...ws, github: ws.github ?? GITHUB_DEFAULT })` で通す（zod で再検証されるのでより安全）。

- [ ] **Step 4: GREEN 確認** — Run: `cd packages/behavior && pnpm vitest run` Expected: 全パス（608+）

- [ ] **Step 5: コミット**

```bash
git add packages/behavior/src/config/load.ts packages/behavior/src/config/load.test.ts
git commit -m "feat(behavior): loadConfig falls back to workspace.yaml"
```

---

### Task 3: cli — viewer サーバの抽出（serve.ts）

**Files:**
- Create: `packages/cli/src/commands/serve.ts`
- Modify: `packages/cli/src/index.ts`（cmdServe の中身を移設し、`case "serve"` は新モジュールを呼ぶ）
- Test: `packages/cli/src/commands/serve.test.ts`

**Interfaces:**
- Consumes: `buildViewModel` / `assembleDiff`（@crawl-kit/viewer）、`VIEWER_HTML`（index.ts が import している `../../viewer/index.html`。serve.ts へは **引数で渡す**: bundle 時の import は index.ts に残す）
- Produces:
  - `startViewer(opts: { port: number; host: string; html: string }): Promise<{ close(): Promise<void>; port: number; urls: string[] }>` — 現 cmdServe のルーティング（`/view-model.json`, `/diff.json`, `/`）そのまま。listen 完了で resolve。`urls` は表示用（localhost + LAN IP）
  - `cmdServe(args, html)` — 既存挙動（表示して待機）を startViewer で再実装
  - run（Task 5）が `startViewer` を再利用する

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, it } from "vitest";
import { startViewer } from "./serve.js";

describe("startViewer", () => {
  it("serves the html shell and closes cleanly", async () => {
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>ok</html>" });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/`);
      expect(await res.text()).toContain("ok");
      const notFound = await fetch(`http://127.0.0.1:${viewer.port}/nope`);
      expect(notFound.status).toBe(404);
    } finally {
      await viewer.close();
    }
  });
});
```

（`port: 0` = OS 任せの空きポート。`startViewer` は `server.address()` から実ポートを返すこと。view-model.json はデータ依存なのでここでは叩かない。）

- [ ] **Step 2: RED 確認** — Run: `cd packages/cli && pnpm vitest run src/commands/serve.test.ts` Expected: FAIL

- [ ] **Step 3: 実装** — 現 `cmdServe`（index.ts:320 付近）の createServer/lanAddress ロジックを serve.ts へ移設し、`startViewer` として export。listen を Promise 化し `{ close, port, urls }` を返す。`cmdServe(args, html)` は startViewer を呼んで URL を console.log し、待機（close しない）。index.ts 側は `case "serve": return cmdServe(args, VIEWER_HTML);` に差し替え、旧実装と `lanAddress` を削除。

- [ ] **Step 4: GREEN 確認** — Run: `cd packages/cli && pnpm vitest run && pnpm lint` Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/commands/serve.ts packages/cli/src/commands/serve.test.ts packages/cli/src/index.ts
git commit -m "refactor(cli): extract startViewer from cmdServe for reuse by run"
```

---

### Task 4: cli — `clear` コマンド（フェーズ別リセット）

**Files:**
- Create: `packages/cli/src/commands/clear.ts`
- Test: `packages/cli/src/commands/clear.test.ts`

**Interfaces:**
- Consumes: `findWorkspaceRoot` / `progressPath` / `DATA_FILES`（contract）、`readProgressOrEmpty` / `writeProgress` / `emptyProgress` / `withPhaseStatus`（contract）、`readStore` / `writeStore` / `acquisitionPath`（freshness — cli の index.ts が import 済みのシンボルと同じもの）
- Produces:
  - `clearPhase(root: string, phase?: "intent" | "structure" | "behavior", opts?: { all?: boolean }): Promise<string[]>` — 削除/リセットした対象の一覧を返す
  - `cmdClear(args: string[]): Promise<void>` — `crawl-kit clear [--phase intent|structure|behavior] [--all]`
- 削除マッピング（スペック C 節「テスト用にクリアして一から再生成」）:

| phase | 消すもの |
|---|---|
| intent | `data/intent.nodes.json`、progress.intent を pending にリセット |
| structure | `data/structure.*`（nodes/rdra/er.mmd/usecases.mmd/routes.partial — corrections.json は人間の資産なので**残す**）、workspace 直下と各 repo 直下の `.crawl-kit-cache/`、acquisition.structure を `{}` に、progress.structure リセット |
| behavior | `data/behavior.nodes.json`・`data/behavior.transactions.jsonl`、acquisition.behavior を `{}` に、progress.behavior リセット |
| 指定なし | 上記 3 フェーズ全部 + `data/unified.json`・`data/verification.findings.json`・`data/boundary.findings.json`（派生物）+ progress 全体を emptyProgress に。**registry.json / decisions.json / structure.corrections.json は残す** |
| --all | 指定なしに加えて `data/registry.json`・`data/decisions.json` も削除（要 `--all` 明示） |

- ファイル削除は `rm(path, { force: true })`、ディレクトリは `rm(dir, { recursive: true, force: true })`。存在しないものは黙ってスキップ。
- progress リセット: phase 指定時は `withPhaseStatus(p, phase, "pending")` で status を戻し tasks を 0/0 に（`withTasksRegistered(p, phase, 0)` を併用し、startedAt 等の古いスタンプが残ってよい — status が pending なら consumer は無視する。ただし blockedReason は誤解を生むため、phase リセット時に blockedReason を落とした新 PhaseProgress を作る小さな純関数 `resetPhase(p, phase)` を clear.ts 内に定義して使う）。

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearPhase } from "./clear.js";
import { emptyProgress, readProgressOrEmpty, withPhaseStatus, writeProgress, progressPath } from "@crawl-kit/contract";

async function makeWorkspaceWithData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ck-clear-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
  await mkdir(join(root, "data"), { recursive: true });
  for (const f of ["intent.nodes.json", "structure.nodes.json", "structure.rdra.json", "behavior.nodes.json", "unified.json", "registry.json"]) {
    await writeFile(join(root, "data", f), "{}", "utf8");
  }
  await mkdir(join(root, ".crawl-kit-cache"), { recursive: true });
  return root;
}

describe("clearPhase", () => {
  it("clears only the given phase's artifacts and resets its ledger entry", async () => {
    const root = await makeWorkspaceWithData();
    const p = withPhaseStatus(emptyProgress("r"), "structure", "completed");
    await writeProgress(progressPath(root), p);
    await clearPhase(root, "structure");
    expect(existsSync(join(root, "data", "structure.nodes.json"))).toBe(false);
    expect(existsSync(join(root, ".crawl-kit-cache"))).toBe(false);
    expect(existsSync(join(root, "data", "intent.nodes.json"))).toBe(true); // untouched
    const after = await readProgressOrEmpty(progressPath(root), "x");
    expect(after.phases.structure.status).toBe("pending");
    expect(after.phases.intent.status).toBe("pending"); // unchanged (was pending)
  });

  it("full clear removes derived artifacts but keeps registry.json", async () => {
    const root = await makeWorkspaceWithData();
    await clearPhase(root, undefined);
    expect(existsSync(join(root, "data", "unified.json"))).toBe(false);
    expect(existsSync(join(root, "data", "registry.json"))).toBe(true);
  });

  it("--all removes the registry too", async () => {
    const root = await makeWorkspaceWithData();
    await clearPhase(root, undefined, { all: true });
    expect(existsSync(join(root, "data", "registry.json"))).toBe(false);
  });
});
```

- [ ] **Step 2: RED 確認** — Run: `cd packages/cli && pnpm vitest run src/commands/clear.test.ts` Expected: FAIL

- [ ] **Step 3: 実装** — 上記マッピング表のとおり。repo 直下の `.crawl-kit-cache` は workspace.yaml の repositories[].path から解決（読み込みは `loadWorkspaceConfig` でなく `readYamlFile` + 緩い型で十分 — env 解決不要のため）。`cmdClear` は結果一覧を console.log。ワークスペース外なら usage エラー。

- [ ] **Step 4: GREEN 確認** — Run: `cd packages/cli && pnpm vitest run && pnpm lint` Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/commands/clear.ts packages/cli/src/commands/clear.test.ts
git commit -m "feat(cli): clear command — phase-scoped artifact reset"
```

---

### Task 5: cli — `run` オーケストレータ

**Files:**
- Create: `packages/cli/src/commands/run.ts`
- Test: `packages/cli/src/commands/run.test.ts`

**Interfaces:**
- Consumes:
  - contract: `findWorkspaceRoot`, `progressPath`, `dataPath`, `DATA_FILES`, progress 純関数群 + `readProgressOrEmpty`/`writeProgress`
  - cli: `runDoctor`/`blockedPhases`（doctor.ts）、`startViewer`（serve.ts）、`clearPhase`（clear.ts — `--force` 用）
  - behavior: `loadWorkspaceConfig`
  - structure: `analyzeRepoIncremental`（`onPass`/`onUnit`）、`enumerateUnits`
  - intent: `emitIntentNodes`, `type Glossary`
  - freshness / reconciler / verification: index.ts の既存 cmdReconcile/cmdVerify 相当を **index.ts から関数として import できるよう最小限 export するのではなく**、run.ts に依存注入する（下記 `RunDeps`）
- Produces:
  - `cmdRunWorkspace(args: string[], deps: RunDeps): Promise<void>`
  - `type RunDeps = { html: string; reconcile(): Promise<void>; verify(): Promise<void>; analyzeStructureRepo(repoPath: string, hooks: { onPass: ...; onUnit: ... }): Promise<void>; runBehavior(cwd: string): Promise<{ ok: boolean; crawledPages: number }>; doctor?: typeof runDoctor; viewer?: typeof startViewer }` — index.ts が既存実装（cmdReconcile/cmdVerify/loop-e2e spawn）を包んで渡す。テストは全部 fake を注入
- フロー（スペック C 節）:

```
cmdRunWorkspace(args):
  root = findWorkspaceRoot() ?? throw（"crawl-kit setup または migrate を実行してください"）
  flags: --only intent|structure|behavior, --force, --no-viewer, --port N
  --force なら clearPhase(root, onlyPhase)   // 全部 or 指定フェーズ
  config = loadWorkspaceConfig(root)          // maxParallel, regenerateTtlSeconds
  CLAUDE_CODE_MAX_CONCURRENCY 未設定なら config.maxParallel を process.env へ
  progress = readProgressOrEmpty(progressPath(root), runId = `run-${Date.now()}`)
  checks = doctor(root); blocked = blockedPhases(checks)
  blocked の各フェーズ → withPhaseStatus(blocked, reason) して writeProgress（表示も）
  viewer = --no-viewer でなければ startViewer({ port, host: "0.0.0.0", html }) して URL 表示
  各フェーズ実行（--only 指定時はそのフェーズ + reconcile/verify のみ）:
    skip 条件: phase.status === "completed" && completedAt が regenerateTtlSeconds 以内 → skip 表示
    blocked 条件: blocked.has(phase) → スキップ（台帳は上で記録済み）
    実行: withPhaseStatus(running) → 本体 → completed / catch で failed（メッセージを console.error、後続の依存フェーズは実行継続可否を判断: intent 失敗→ structure 続行, structure 失敗→ behavior/reconcile/verify スキップ）
    各遷移ごとに writeProgress
  フェーズ本体:
    intent:  docs/domain/intent.json があれば emitIntentNodes → data/intent.nodes.json（tasks 1/1）
             なければ withPhaseStatus(blocked, "docs/domain/intent.json なし — distill-ddd を実行してください")
    structure: repos = config.repositories.filter(path が存在)
             total = Σ enumerateUnits(repoPath).length × 3 を withTasksRegistered
             for repo of repos（直列 — unit 並列は engine 内で maxParallel が効く）:
               deps.analyzeStructureRepo(repoPath, { onUnit: () => taskDone(1), onPass: ... })
    reconcile: deps.reconcile()（tasks 1/1）
    behavior: deps.runBehavior(root) — loop-e2e run+emit（cwd=root、Task 2 の fallback で workspace.yaml を読む）
             実行前に withTasksRegistered(planBehaviorCrawl の toCrawl 数 — 取れなければ 1)
             完了後 withTaskCompleted(crawledPages)
    verify:  deps.verify()（tasks 1/1）
  完了サマリ表示（フェーズ別 status/tasks）。viewer 起動中なら「Ctrl-C で終了」で待機、--no-viewer なら終了
```

- マルチリポの structure 出力マージ: `analyzeStructureRepo` の実装（index.ts 側、Task 6）は repo ごとの extract を集めて **連結マージ**（routes/entities/usecases/events/transitions を concat、各レコードに `repo: <name>` を付与 — `StructureExtract` のレコード型に `repo?: string` を追加する必要はなく、`(r) => ({ ...r, repo: name })` のスプレッドで動的付与し `writeStructureOutputs` にはマージ済み extract を 1 回だけ渡す。TS 上は `as` でなく交差型 `& { repo?: string }` のローカル型で扱う）。単一 repo のときは従来同様。
- resume の要: structure/behavior の中身は freshness（acquisition.json + fragment cache）が既に持っている。run 側は「フェーズ completed かつ TTL 内 → スキップ」の粗い gate と、「running のまま中断 → 再実行で再開（engine 側キャッシュが効くので unit 単位で速い）」で成立させる。

- [ ] **Step 1: 失敗するテストを書く**（全依存 fake 注入。ポイントのみ — 実装時に肉付け）

```typescript
// run.test.ts の必須ケース:
// 1. 正常系: 全フェーズ completed、progress.json に 5 フェーズの completed と tasks が記録される
//    （fake analyzeStructureRepo は onUnit を 3 回呼ぶ → structure.tasks.completed === 3）
// 2. doctor が behavior をブロック → behavior.status === "blocked"（blockedReason に db: 等）、
//    intent/structure/reconcile/verify は completed
// 3. --only structure → intent は pending のまま、structure + reconcile + verify のみ実行
// 4. resume: 事前に structure を completed（completedAt = 今）で書いておく → fake が呼ばれない
// 5. TTL 切れ: completedAt を 25h 前にする → fake が呼ばれる
// 6. structure 本体が throw → structure.status === "failed"、behavior/verify はスキップ（pending のまま）
// 7. intent.json 不在 → intent.status === "blocked"、structure は実行される
// 各ケースで viewer は { close: async()=>{} } を返す fake、doctor は全 ok の fake（ケース2以外）
```

fake workspace は Task 4 のテストと同じ `makeWorkspace` ヘルパー流儀で作る（workspace.yaml に repositories 1 件 + `path` の実在ディレクトリ）。時計は `deps.now?: () => Date` を RunDeps に足して注入可能にする（TTL テスト用。デフォルト `() => new Date()`）。

- [ ] **Step 2: RED 確認** — Run: `cd packages/cli && pnpm vitest run src/commands/run.test.ts` Expected: FAIL

- [ ] **Step 3: 実装** — 上記フローを素直に。フェーズ実行の共通枠は内部ヘルパー `runPhase(name, body)` に括り出し（status 遷移 + writeProgress + try/catch）、console 出力は cmdRunWorkspace 内のみ。ファイルが 400 行を超えそうなら `run-phases.ts` に フェーズ本体を分割してよい（その場合も console はハンドラ側）。

- [ ] **Step 4: GREEN 確認** — Run: `cd packages/cli && pnpm vitest run && pnpm lint` Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/commands/run.ts packages/cli/src/commands/run.test.ts
git commit -m "feat(cli): workspace run orchestrator — phased pipeline with ledger + resume"
```

---

### Task 6: cli — index.ts 結線（run 再定義 / clear / RunDeps 実装）

**Files:**
- Modify: `packages/cli/src/index.ts`
- Test: 既存テスト全緑 + Task 7 のスモークで検証（このタスクに新規ユニットテストは不要 — 結線のみ）

**Interfaces:**
- Consumes: `cmdRunWorkspace`/`RunDeps`（Task 5）、`cmdClear`（Task 4）、`cmdServe`/`startViewer`（Task 3）、既存 cmdReconcile/cmdVerify/runIncremental/loop-e2e spawn ロジック
- Produces:
  - `case "run"`: `findWorkspaceRoot()` が非 null なら `cmdRunWorkspace(args, deps)`、null かつ repo 引数ありなら従来の `cmdRun(args)`（レガシー互換）、どちらでもなければ setup/migrate への誘導メッセージ
  - `case "clear"`: `cmdClear(args)`
  - RunDeps 実装:
    - `reconcile: () => cmdReconcile()` / `verify: () => cmdVerify()`
    - `analyzeStructureRepo`: `analyzeRepoIncremental(repoPath, { onPass: (pass, extract) => {…既存 runIncremental の onPass と同じ partial/emit 処理…}, onUnit: hooks.onUnit })` — マルチリポ時のマージは Task 5 の指示どおり（extract を貯めて最後に 1 回 writeStructureOutputs）。freshness 記録（scanByDir/recordStructure）も repo ごとに従来どおり
    - `runBehavior`: 既存 cmdAnalyzeBehavior の loop-e2e spawn 部を流用（resolveLoopE2e → run → emit → recordBehavior、crawledPages を返す）
    - `html: VIEWER_HTML`
  - HELP 更新: `run` の説明を統合コマンドに、`clear` を追加

- [ ] **Step 1: 結線実装**（上記）
- [ ] **Step 2: 検証** — Run: `cd packages/cli && pnpm vitest run && pnpm lint` Expected: PASS（既存 26+ 新規全部）
- [ ] **Step 3: コミット**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): wire workspace run + clear into dispatch"
```

---

### Task 7: 全体検証 + スモーク + README

**Files:**
- Modify: `README.md`（run/clear の節、統合コマンドのフロー図をスペック C 節から転記）

- [ ] **Step 1: モノレポ全体検証** — Run: `pnpm -r lint && pnpm -r test && pnpm --filter @tanago3/crawl-kit build` Expected: 全緑
- [ ] **Step 2: スモーク（scratch workspace で実 CLI）**

```bash
W=$(mktemp -d); cd "$W"
mkdir -p .crawl-kit repo-a/.git data docs/domain
printf 'repositories:\n  - { name: repo-a, label: A, url: "https://example.com/a.git", role: backend, audience: user, path: repo-a }\n' > .crawl-kit/workspace.yaml
printf '{"concepts": [], "events": [], "transitions": []}' > docs/domain/intent.json
timeout 60 node <repo>/packages/cli/dist/index.js run --no-viewer; echo "exit=$?"
cat .crawl-kit/progress.json
```

Expected: プロセスが自力終了（exit が 124/142 でない）。progress.json に intent=completed（0 concept でも可）、structure=completed か failed（repo-a は空 repo なので unit 0 で completed 想定）、behavior=blocked（target 未設定）または completed(0)、reconcile/verify=completed。**「どのフェーズがなぜ blocked/failed か」が progress.json から読み取れること**が合格条件。
続けて resume 確認: 同コマンド再実行 → structure が「skip（TTL内）」相当のログで即完了。
続けて clear 確認: `node <repo>/dist run` 済みの状態で `node <repo>/packages/cli/dist/index.js clear --phase structure` → data/structure.* が消え progress.structure が pending。

- [ ] **Step 3: README 更新 + コミット**

```bash
git add README.md
git commit -m "docs: unified run + clear usage"
```

---

## Self-Review 結果（プラン作成時に実施済み）

- **スペック網羅（C 節）**: フロー全段 → Task 5/6。進捗台帳スキーマ → P1 済み + Task 5 が記録。resume/TTL → Task 5（skip gate）+ 既存 freshness。`--only`/`clear`/`--force` → Task 4/5。並列上限 → Task 5（env ブリッジ）+ Task 1（unit 並列は engine 既存）。viewer 自動起動 → Task 3/5。E 節マルチリポ → Task 5/6（連結マージ + repo タグ）。**P2 に含めないもの**: distill-ddd 自動ドラフト（P3）、behavior.sitemap / persisted 印（P4）、viewer 4 メニュー（P5）、`.crawl-kit-cache`/`.e2e` のワークスペース直下移設（P4 で behavior と併せて対応 — 最終レビュー Minor #12 の持ち越し）。
- **型整合**: `onUnit` シグネチャは Task 1 と Task 5 で一致。`RunDeps` は Task 5 定義 / Task 6 実装。`startViewer` は Task 3 定義 / Task 5 消費。`clearPhase` は Task 4 定義 / Task 5 (--force) 消費。
- **順序**: Task 1（structure）と Task 2（behavior）と Task 3/4（cli）は相互独立。Task 5 は 1-4 に依存。Task 6 は 5。Task 7 は最後。
