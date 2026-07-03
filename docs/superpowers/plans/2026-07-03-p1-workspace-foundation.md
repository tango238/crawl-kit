# P1: Workspace Foundation (setup / doctor / migrate / 進捗台帳) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ワークスペース（ルートdir + `.crawl-kit/`）を crawl-kit の唯一の作業単位にし、`setup` / `doctor` / `migrate` コマンドと進捗台帳を実装する。

**Architecture:** contract パッケージ（spine）にワークスペース探索と進捗台帳（JSON）を追加。workspace.yaml / repos/*.yaml のスキーマとローダーは behavior パッケージの config に置く（yaml 依存が既にあるため）。CLI コマンドは `packages/cli/src/commands/` に1ファイル1コマンドで新設し、既存の switch dispatch に配線する。

**Tech Stack:** TypeScript (ESM, Node>=20), zod ^3.24, yaml, Vitest, esbuild (cli bundle), pnpm workspace

**親スペック:** `docs/superpowers/specs/2026-07-03-workspace-unified-pipeline-design.md`

## Global Constraints

- Node >= 20 / `"type": "module"` / import は `.js` 拡張子付き相対パス
- 既存パターンに従う: contract は zod のみ依存・yaml 依存を追加しない。yaml は behavior の `readYaml`/`writeYaml`（`packages/behavior/src/util/fs.ts`）を使う
- **イミュータブル**: 進捗台帳の更新はすべて新オブジェクトを返す純関数（mutation 禁止）
- ライブラリコードに `console.log` を書かない（CLI コマンドハンドラ内の出力のみ可）
- ファイルは小さく分割（1ファイル 400 行以内目安）
- コミットメッセージ: `<type>: <description>`（feat / fix / refactor / docs / test / chore）
- 各タスク: テスト先行（RED → GREEN）→ コミット
- テスト実行はパッケージ dir で `pnpm vitest run <file>`、全体は root で `pnpm test`
- パス表記はすべてリポジトリ `/Users/go/work/github/crawl-kit` からの相対

---

### Task 1: contract — 汎用 atomic JSON I/O のエクスポート

**Files:**
- Modify: `packages/contract/src/io.ts`
- Modify: `packages/contract/src/index.ts`
- Test: `packages/contract/src/io.test.ts`（既存に追記）

**Interfaces:**
- Consumes: 既存の内部 `writeAtomic` / `readJson`（io.ts 内 private）
- Produces:
  - `readJsonFile<T>(path: string): Promise<T>` — JSON 読み込み（存在しない/壊れている場合 throw）
  - `readJsonFileOr<T>(path: string, fallback: T): Promise<T>` — 読めなければ fallback
  - `writeJsonAtomic(path: string, data: unknown): Promise<void>` — temp+rename の atomic 書き込み

- [ ] **Step 1: 失敗するテストを書く**

`packages/contract/src/io.test.ts` に追記:

```typescript
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, readJsonFileOr, writeJsonAtomic } from "./io.js";

describe("generic json io", () => {
  it("writeJsonAtomic then readJsonFile roundtrips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-io-"));
    const p = join(dir, "nested", "x.json");
    await writeJsonAtomic(p, { a: 1 });
    expect(await readJsonFile<{ a: number }>(p)).toEqual({ a: 1 });
    expect(await readFile(p, "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  it("readJsonFileOr falls back when file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-io-"));
    expect(await readJsonFileOr(join(dir, "none.json"), { b: 2 })).toEqual({ b: 2 });
  });

  it("readJsonFile throws on invalid json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-io-"));
    const p = join(dir, "bad.json");
    await writeJsonAtomic(p, "x");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(p, "{oops", "utf8");
    await expect(readJsonFile(p)).rejects.toThrow(/not valid JSON/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd packages/contract && pnpm vitest run src/io.test.ts`
Expected: FAIL — `readJsonFile is not exported`

- [ ] **Step 3: 実装**

`packages/contract/src/io.ts` — 既存 private 関数を薄く公開する（既存の `readJson`/`writeAtomic` はそのまま使う）:

```typescript
/** Read + parse a JSON file. Throws with a path-carrying message on failure. */
export async function readJsonFile<T>(path: string): Promise<T> {
  return (await readJson(path)) as T;
}

/** Read + parse a JSON file, or return `fallback` when it can't be read/parsed. */
export async function readJsonFileOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return (await readJson(path)) as T;
  } catch {
    return fallback;
  }
}

/** Atomically write pretty-printed JSON (temp file + rename). */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeAtomic(path, data);
}
```

`packages/contract/src/index.ts` の io エクスポート行に `readJsonFile, readJsonFileOr, writeJsonAtomic` を追加（既存の `readRegistry` 等と同じ export 文に並べる）。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd packages/contract && pnpm vitest run src/io.test.ts`
Expected: PASS（既存テスト含む）

- [ ] **Step 5: コミット**

```bash
git add packages/contract/src/io.ts packages/contract/src/io.test.ts packages/contract/src/index.ts
git commit -m "feat(contract): export generic atomic json io"
```

---

### Task 2: contract — ワークスペース探索（workspace.ts）

**Files:**
- Create: `packages/contract/src/workspace.ts`
- Modify: `packages/contract/src/paths.ts`（`dataPath` をワークスペース対応に）
- Modify: `packages/contract/src/index.ts`
- Test: `packages/contract/src/workspace.test.ts`

**Interfaces:**
- Consumes: `findRepoRoot(start?)`（paths.ts 既存）
- Produces:
  - `CRAWL_KIT_DIR = ".crawl-kit"` / `WORKSPACE_FILES = { config: "workspace.yaml", progress: "progress.json" } as const`
  - `findWorkspaceRoot(start?: string): string | null` — 上方向へ `.crawl-kit/workspace.yaml` を探す
  - `resolveRoot(start?: string): string` — workspace root、なければ `findRepoRoot` にフォールバック
  - `crawlKitPath(root: string, ...segments: string[]): string` — `<root>/.crawl-kit/...`
  - `workspaceConfigPath(root: string): string` / `progressPath(root: string): string` / `repoConfigPath(root: string, name: string): string`（= `<root>/.crawl-kit/repos/<name>.yaml`）
  - `dataPath(name, start?)`（既存シグネチャ維持）が workspace root を優先するようになる

- [ ] **Step 1: 失敗するテストを書く**

`packages/contract/src/workspace.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findWorkspaceRoot,
  resolveRoot,
  crawlKitPath,
  workspaceConfigPath,
  progressPath,
  repoConfigPath,
} from "./workspace.js";
import { dataPath } from "./paths.js";

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ck-ws-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
  return root;
}

describe("workspace discovery", () => {
  it("finds workspace root from a nested dir", async () => {
    const root = await makeWorkspace();
    const nested = join(root, "backend", "app");
    await mkdir(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(root);
  });

  it("returns null when no workspace marker exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-nows-"));
    expect(findWorkspaceRoot(dir)).toBeNull();
  });

  it("resolveRoot prefers workspace over package.json fallback", async () => {
    const root = await makeWorkspace();
    const repo = join(root, "backend");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), "{}", "utf8");
    expect(resolveRoot(repo)).toBe(root);
  });

  it("path helpers compose under .crawl-kit", () => {
    expect(crawlKitPath("/w", "a", "b")).toBe("/w/.crawl-kit/a/b");
    expect(workspaceConfigPath("/w")).toBe("/w/.crawl-kit/workspace.yaml");
    expect(progressPath("/w")).toBe("/w/.crawl-kit/progress.json");
    expect(repoConfigPath("/w", "backend")).toBe("/w/.crawl-kit/repos/backend.yaml");
  });

  it("dataPath resolves under the workspace root", async () => {
    const root = await makeWorkspace();
    const nested = join(root, "backend");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), "{}", "utf8");
    expect(dataPath("unified.json", nested)).toBe(join(root, "data", "unified.json"));
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd packages/contract && pnpm vitest run src/workspace.test.ts`
Expected: FAIL — `Cannot find module './workspace.js'`

- [ ] **Step 3: 実装**

`packages/contract/src/workspace.ts`:

```typescript
// packages/contract/src/workspace.ts
//
// Workspace discovery. A "workspace" is a root directory holding cloned repos,
// marked by `.crawl-kit/workspace.yaml`. It is the single unit of work: config,
// progress ledger, and all data/ artifacts live under it. Tools resolve paths
// through here so every package agrees on "where things are".

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findRepoRoot } from "./paths.js";

export const CRAWL_KIT_DIR = ".crawl-kit";

export const WORKSPACE_FILES = {
  config: "workspace.yaml",
  progress: "progress.json",
} as const;

/** Walk upward looking for `.crawl-kit/workspace.yaml`. Null when not inside a workspace. */
export function findWorkspaceRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CRAWL_KIT_DIR, WORKSPACE_FILES.config))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Workspace root when inside one, else the legacy repo-root fallback. */
export function resolveRoot(start: string = process.cwd()): string {
  return findWorkspaceRoot(start) ?? findRepoRoot(start);
}

/** `<root>/.crawl-kit/<segments...>` */
export function crawlKitPath(root: string, ...segments: string[]): string {
  return join(root, CRAWL_KIT_DIR, ...segments);
}

export function workspaceConfigPath(root: string): string {
  return crawlKitPath(root, WORKSPACE_FILES.config);
}

export function progressPath(root: string): string {
  return crawlKitPath(root, WORKSPACE_FILES.progress);
}

export function repoConfigPath(root: string, name: string): string {
  return crawlKitPath(root, "repos", `${name}.yaml`);
}
```

`packages/contract/src/paths.ts` — `dataPath` をワークスペース優先に（循環 import を避けるため `findWorkspaceRoot` の再実装はせず、workspace.ts から import **しない**。代わりに paths.ts 内で marker を直接見る）:

```typescript
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Same walk as workspace.ts#findWorkspaceRoot — duplicated here (3 lines) to keep
 *  paths.ts dependency-free and avoid a paths↔workspace import cycle. */
function workspaceRootOrNull(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".crawl-kit", "workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Absolute path to a file in the workspace (preferred) or legacy repo data/ directory. */
export function dataPath(name: string, start?: string): string {
  const base = workspaceRootOrNull(start ?? process.cwd()) ?? findRepoRoot(start);
  return join(base, "data", name);
}
```

（`findRepoRoot` と `DATA_FILES` は変更なし。）

`packages/contract/src/index.ts` に追加:

```typescript
export {
  CRAWL_KIT_DIR,
  WORKSPACE_FILES,
  findWorkspaceRoot,
  resolveRoot,
  crawlKitPath,
  workspaceConfigPath,
  progressPath,
  repoConfigPath,
} from "./workspace.js";
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd packages/contract && pnpm vitest run`
Expected: PASS（全既存テスト含む — 特に paths 系のテストが workspace なし環境で従来挙動を維持していること）

- [ ] **Step 5: コミット**

```bash
git add packages/contract/src/workspace.ts packages/contract/src/workspace.test.ts packages/contract/src/paths.ts packages/contract/src/index.ts
git commit -m "feat(contract): workspace discovery + workspace-aware dataPath"
```

---

### Task 3: contract — 進捗台帳（progress.ts）

**Files:**
- Create: `packages/contract/src/progress.ts`
- Modify: `packages/contract/src/index.ts`
- Test: `packages/contract/src/progress.test.ts`

**Interfaces:**
- Consumes: `readJsonFileOr` / `writeJsonAtomic`（Task 1）、`progressPath`（Task 2）
- Produces:
  - 型: `PhaseName = "intent" | "structure" | "behavior" | "reconcile" | "verify"`
  - 型: `PhaseStatus = "pending" | "running" | "completed" | "blocked" | "failed"`
  - 型: `PhaseProgress = { status: PhaseStatus; startedAt?: string; completedAt?: string; blockedReason?: string; tasks: { total: number; completed: number } }`
  - 型: `Progress = { runId: string; phases: Record<PhaseName, PhaseProgress>; updatedAt: string }`
  - `PHASE_NAMES: readonly PhaseName[]`
  - `emptyProgress(runId: string, now?: string): Progress` — 全フェーズ pending / tasks 0/0
  - `withPhaseStatus(p: Progress, phase: PhaseName, status: PhaseStatus, opts?: { reason?: string; now?: string }): Progress`（純関数・イミュータブル。running で startedAt、completed/failed で completedAt、blocked で blockedReason を刻む）
  - `withTasksRegistered(p: Progress, phase: PhaseName, total: number, now?: string): Progress`
  - `withTaskCompleted(p: Progress, phase: PhaseName, count?: number, now?: string): Progress`（completed を total 上限まで加算）
  - `readProgressOrEmpty(path: string, runId: string): Promise<Progress>`
  - `writeProgress(path: string, p: Progress): Promise<void>`（zod 検証 → atomic 書き込み）

- [ ] **Step 1: 失敗するテストを書く**

`packages/contract/src/progress.test.ts`:

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyProgress,
  readProgressOrEmpty,
  withPhaseStatus,
  withTaskCompleted,
  withTasksRegistered,
  writeProgress,
  PHASE_NAMES,
} from "./progress.js";

const T0 = "2026-07-03T00:00:00.000Z";
const T1 = "2026-07-03T00:01:00.000Z";

describe("progress ledger", () => {
  it("emptyProgress has all phases pending with 0/0 tasks", () => {
    const p = emptyProgress("run-1", T0);
    expect(PHASE_NAMES).toEqual(["intent", "structure", "behavior", "reconcile", "verify"]);
    for (const name of PHASE_NAMES) {
      expect(p.phases[name]).toEqual({ status: "pending", tasks: { total: 0, completed: 0 } });
    }
    expect(p.updatedAt).toBe(T0);
  });

  it("withPhaseStatus is immutable and stamps timestamps", () => {
    const p0 = emptyProgress("run-1", T0);
    const p1 = withPhaseStatus(p0, "structure", "running", { now: T1 });
    expect(p0.phases.structure.status).toBe("pending"); // no mutation
    expect(p1.phases.structure.status).toBe("running");
    expect(p1.phases.structure.startedAt).toBe(T1);
    const p2 = withPhaseStatus(p1, "structure", "completed", { now: T1 });
    expect(p2.phases.structure.completedAt).toBe(T1);
  });

  it("blocked records the reason", () => {
    const p = withPhaseStatus(emptyProgress("r", T0), "behavior", "blocked", {
      reason: "DB接続失敗: ECONNREFUSED",
      now: T1,
    });
    expect(p.phases.behavior.blockedReason).toBe("DB接続失敗: ECONNREFUSED");
  });

  it("task counters register and complete, capped at total", () => {
    let p = withTasksRegistered(emptyProgress("r", T0), "structure", 3, T1);
    expect(p.phases.structure.tasks).toEqual({ total: 3, completed: 0 });
    p = withTaskCompleted(p, "structure", 2, T1);
    p = withTaskCompleted(p, "structure", 5, T1);
    expect(p.phases.structure.tasks).toEqual({ total: 3, completed: 3 });
  });

  it("roundtrips through disk and falls back to empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-prog-"));
    const path = join(dir, "progress.json");
    expect((await readProgressOrEmpty(path, "fresh")).runId).toBe("fresh");
    const p = withPhaseStatus(emptyProgress("r", T0), "intent", "running", { now: T1 });
    await writeProgress(path, p);
    expect(await readProgressOrEmpty(path, "ignored")).toEqual(p);
  });

  it("writeProgress rejects an invalid ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-prog-"));
    const bad = { runId: "r", phases: {}, updatedAt: T0 } as never;
    await expect(writeProgress(join(dir, "p.json"), bad)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd packages/contract && pnpm vitest run src/progress.test.ts`
Expected: FAIL — `Cannot find module './progress.js'`

- [ ] **Step 3: 実装**

`packages/contract/src/progress.ts`:

```typescript
// packages/contract/src/progress.ts
//
// The progress ledger (.crawl-kit/progress.json): which pipeline phases ran,
// how many tasks each planned/completed, and why a phase is blocked. The
// dashboard and the CLI both read this file, so it lives on the spine.
// All updaters are pure — they return new objects, never mutate.

import { z } from "zod";
import { readJsonFileOr, writeJsonAtomic } from "./io.js";

export const PHASE_NAMES = ["intent", "structure", "behavior", "reconcile", "verify"] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

const PhaseStatusSchema = z.enum(["pending", "running", "completed", "blocked", "failed"]);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

const PhaseProgressSchema = z.object({
  status: PhaseStatusSchema,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  blockedReason: z.string().optional(),
  tasks: z.object({ total: z.number().int().min(0), completed: z.number().int().min(0) }),
});
export type PhaseProgress = z.infer<typeof PhaseProgressSchema>;

const ProgressSchema = z.object({
  runId: z.string().min(1),
  phases: z.object({
    intent: PhaseProgressSchema,
    structure: PhaseProgressSchema,
    behavior: PhaseProgressSchema,
    reconcile: PhaseProgressSchema,
    verify: PhaseProgressSchema,
  }),
  updatedAt: z.string(),
});
export type Progress = z.infer<typeof ProgressSchema>;

const now = (given?: string): string => given ?? new Date().toISOString();

export function emptyProgress(runId: string, at?: string): Progress {
  const phase: PhaseProgress = { status: "pending", tasks: { total: 0, completed: 0 } };
  return {
    runId,
    phases: {
      intent: phase,
      structure: phase,
      behavior: phase,
      reconcile: phase,
      verify: phase,
    },
    updatedAt: now(at),
  };
}

function withPhase(p: Progress, phase: PhaseName, next: PhaseProgress, at?: string): Progress {
  return { ...p, phases: { ...p.phases, [phase]: next }, updatedAt: now(at) };
}

export function withPhaseStatus(
  p: Progress,
  phase: PhaseName,
  status: PhaseStatus,
  opts: { reason?: string; now?: string } = {},
): Progress {
  const at = now(opts.now);
  const prev = p.phases[phase];
  return withPhase(
    p,
    phase,
    {
      ...prev,
      status,
      ...(status === "running" ? { startedAt: at } : {}),
      ...(status === "completed" || status === "failed" ? { completedAt: at } : {}),
      ...(status === "blocked" && opts.reason !== undefined ? { blockedReason: opts.reason } : {}),
    },
    at,
  );
}

export function withTasksRegistered(p: Progress, phase: PhaseName, total: number, at?: string): Progress {
  const prev = p.phases[phase];
  return withPhase(p, phase, { ...prev, tasks: { total, completed: Math.min(prev.tasks.completed, total) } }, at);
}

export function withTaskCompleted(p: Progress, phase: PhaseName, count = 1, at?: string): Progress {
  const prev = p.phases[phase];
  const completed = Math.min(prev.tasks.total, prev.tasks.completed + count);
  return withPhase(p, phase, { ...prev, tasks: { ...prev.tasks, completed } }, at);
}

export async function readProgressOrEmpty(path: string, runId: string): Promise<Progress> {
  const raw = await readJsonFileOr<unknown>(path, null);
  if (raw === null) return emptyProgress(runId);
  return ProgressSchema.parse(raw);
}

export async function writeProgress(path: string, p: Progress): Promise<void> {
  ProgressSchema.parse(p);
  await writeJsonAtomic(path, p);
}
```

`packages/contract/src/index.ts` に追加:

```typescript
export {
  PHASE_NAMES,
  emptyProgress,
  withPhaseStatus,
  withTasksRegistered,
  withTaskCompleted,
  readProgressOrEmpty,
  writeProgress,
  type PhaseName,
  type PhaseStatus,
  type PhaseProgress,
  type Progress,
} from "./progress.js";
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd packages/contract && pnpm vitest run`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/contract/src/progress.ts packages/contract/src/progress.test.ts packages/contract/src/index.ts
git commit -m "feat(contract): progress ledger with immutable updaters"
```

---

### Task 4: behavior — workspace.yaml / repos/*.yaml スキーマとローダー

**Files:**
- Modify: `packages/behavior/src/config/schema.ts`
- Modify: `packages/behavior/src/config/load.ts`
- Modify: `packages/behavior/src/index.ts`（エクスポート追加。`config/schema.js` `config/load.js` からの再エクスポートが既にあるか確認し、なければ追加）
- Test: `packages/behavior/src/config/schema.test.ts`（追記）、`packages/behavior/src/config/load.test.ts`（追記）

**Interfaces:**
- Consumes: 既存 `ConfigSchema` / `RepositorySchema` / `loadConfig(root)` / `readYaml`
- Produces:
  - `WorkspaceRepositorySchema` — `RepositorySchema.extend({ path: z.string().optional() })`（path 省略時は name をクローン先 dir とする）
  - `WorkspaceConfigSchema` — ConfigSchema をワークスペース用に緩和・拡張:
    - `repositories: z.array(WorkspaceRepositorySchema).min(1)`
    - `maxParallel: z.number().int().min(1).default(3)`
    - `regenerateTtlSeconds: z.number().int().min(1).default(86400)`
    - `scenarioDir: z.string().min(1).default("scenarios")`
    - `schedule` → default `{ intervalMinutes: 60 }`、`github` → optional、`databases` → default `[]`、`targets` → `.min(1)` を外し default `[]`（setup 直後はまだ埋まっていないため）
  - `type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>`
  - `RepoSetupSchema` — repos/<name>.yaml の形:
    ```
    { framework: z.string(),                            // "laravel" | "nextjs" | ... | "generic"
      structure: z.object({ summary: z.string(), routingDirs: z.array(z.string()).default([]),
                            controllerDirs: z.array(z.string()).default([]), modelDirs: z.array(z.string()).default([]) }),
      devServer: z.object({ command: z.string(), port: z.number().int().optional(),
                            composeFile: z.string().optional() }).optional(),
      dbAccess: z.object({ source: z.string(), envFile: z.string().optional() }).optional(),
      claudeMd: z.object({ present: z.boolean(), source: z.enum(["claude-md", "auto-analysis", "user"]) }) }
    ```
  - `type RepoSetup = z.infer<typeof RepoSetupSchema>`
  - `loadWorkspaceConfig(root: string): Promise<{ config: WorkspaceConfig; secrets: Secrets; missingEnv: string[] }>` — `.crawl-kit/workspace.yaml` を読む。**missing env では throw せず** `missingEnv` に列挙（doctor が報告し、必要なコマンドが使用時点で失敗する）。`.env` はワークスペースルートから読む。
  - `WORKSPACE_CONFIG_RELPATH = ".crawl-kit/workspace.yaml"`

- [ ] **Step 1: 失敗するテストを書く（schema）**

`packages/behavior/src/config/schema.test.ts` に追記:

```typescript
import { WorkspaceConfigSchema, RepoSetupSchema } from './schema.js'

describe('WorkspaceConfigSchema', () => {
  it('fills workspace defaults from a minimal config', () => {
    const c = WorkspaceConfigSchema.parse({
      repositories: [{ name: 'backend', label: 'BE', url: 'https://example.com/r.git', role: 'backend', audience: 'user' }],
    })
    expect(c.maxParallel).toBe(3)
    expect(c.regenerateTtlSeconds).toBe(86400)
    expect(c.scenarioDir).toBe('scenarios')
    expect(c.targets).toEqual([])
    expect(c.databases).toEqual([])
    expect(c.schedule.intervalMinutes).toBe(60)
  })

  it('accepts an optional clone path per repository', () => {
    const c = WorkspaceConfigSchema.parse({
      repositories: [{ name: 'be', label: 'BE', url: 'https://example.com/r.git', role: 'backend', audience: 'user', path: 'services/be' }],
    })
    expect(c.repositories[0]!.path).toBe('services/be')
  })
})

describe('RepoSetupSchema', () => {
  it('parses a full repo setup document', () => {
    const r = RepoSetupSchema.parse({
      framework: 'laravel',
      structure: { summary: 'routes/web.php + app/Http/Controllers', routingDirs: ['routes'], controllerDirs: ['app/Http/Controllers'], modelDirs: ['app/Models'] },
      devServer: { command: 'php artisan serve', port: 8000 },
      dbAccess: { source: '.env', envFile: '.env' },
      claudeMd: { present: false, source: 'auto-analysis' },
    })
    expect(r.framework).toBe('laravel')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd packages/behavior && pnpm vitest run src/config/schema.test.ts`
Expected: FAIL — `WorkspaceConfigSchema is not exported`

- [ ] **Step 3: schema 実装**

`packages/behavior/src/config/schema.ts` の末尾（`CONFIG_FILENAME` の前後）に追加:

```typescript
// ── workspace mode ───────────────────────────────────────────────────────────
// The workspace config (.crawl-kit/workspace.yaml) is ConfigSchema evolved for
// multi-repo workspaces created by `crawl-kit setup`: repos get a local clone
// path, cross-phase knobs (maxParallel, regenerateTtlSeconds) live here, and
// fields a fresh workspace can't know yet (targets, github) become optional.

export const WorkspaceRepositorySchema = RepositorySchema.extend({
  /** Clone destination relative to the workspace root. Defaults to `name`. */
  path: z.string().optional(),
})

export const WorkspaceConfigSchema = ConfigSchema.extend({
  repositories: z.array(WorkspaceRepositorySchema).min(1),
  targets: z.array(TargetSchema).default([]),
  databases: z.array(DbSchema).default([]),
  schedule: z.object({ intervalMinutes: z.number().int().min(1) }).default({ intervalMinutes: 60 }),
  scenarioDir: z.string().min(1).default('scenarios'),
  github: z.object({ labels: z.object({ ready: z.string(), autoDetect: z.string() }) }).optional(),
  /** Shared parallelism cap for every phase (structure fan-out, crawl, LLM calls). */
  maxParallel: z.number().int().min(1).default(3),
  /** Regeneration TTL: artifacts younger than this are reused. */
  regenerateTtlSeconds: z.number().int().min(1).default(86400),
})

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>
export type WorkspaceRepository = z.infer<typeof WorkspaceRepositorySchema>

/** Shape of .crawl-kit/repos/<name>.yaml — per-repo analysis settings written by `setup`. */
export const RepoSetupSchema = z.object({
  framework: z.string(),
  structure: z.object({
    summary: z.string(),
    routingDirs: z.array(z.string()).default([]),
    controllerDirs: z.array(z.string()).default([]),
    modelDirs: z.array(z.string()).default([]),
  }),
  devServer: z
    .object({
      command: z.string(),
      port: z.number().int().optional(),
      composeFile: z.string().optional(),
    })
    .optional(),
  dbAccess: z
    .object({
      /** Where connection info comes from: ".env", "config/database.php", ... */
      source: z.string(),
      envFile: z.string().optional(),
    })
    .optional(),
  claudeMd: z.object({
    present: z.boolean(),
    source: z.enum(['claude-md', 'auto-analysis', 'user']),
  }),
})

export type RepoSetup = z.infer<typeof RepoSetupSchema>

export const WORKSPACE_CONFIG_RELPATH = '.crawl-kit/workspace.yaml'
```

- [ ] **Step 4: schema テストが通ることを確認**

Run: `cd packages/behavior && pnpm vitest run src/config/schema.test.ts`
Expected: PASS

- [ ] **Step 5: 失敗するテストを書く（loader）**

`packages/behavior/src/config/load.test.ts` に追記:

```typescript
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkspaceConfig } from './load.js'

describe('loadWorkspaceConfig', () => {
  async function makeWorkspace(yaml: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ck-wcfg-'))
    await mkdir(join(root, '.crawl-kit'), { recursive: true })
    await writeFile(join(root, '.crawl-kit', 'workspace.yaml'), yaml, 'utf8')
    return root
  }

  it('loads workspace.yaml and lists missing env vars without throwing', async () => {
    delete process.env['CK_TEST_DB_PW']
    const root = await makeWorkspace(
      [
        'repositories:',
        '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
        'databases:',
        '  - { name: main, type: postgres, host: localhost, port: 5432, database: app, user: app, passwordEnv: CK_TEST_DB_PW }',
      ].join('\n'),
    )
    const { config, missingEnv } = await loadWorkspaceConfig(root)
    expect(config.maxParallel).toBe(3)
    expect(missingEnv).toContain('CK_TEST_DB_PW')
  })

  it('resolves env vars that are present', async () => {
    process.env['CK_TEST_DB_PW'] = 'pw'
    const root = await makeWorkspace(
      [
        'repositories:',
        '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
        'databases:',
        '  - { name: main, type: postgres, host: localhost, port: 5432, database: app, user: app, passwordEnv: CK_TEST_DB_PW }',
      ].join('\n'),
    )
    const { secrets, missingEnv } = await loadWorkspaceConfig(root)
    expect(missingEnv).toEqual([])
    expect(secrets.db['CK_TEST_DB_PW']).toBe('pw')
    delete process.env['CK_TEST_DB_PW']
  })
})
```

- [ ] **Step 6: loader テストが失敗することを確認**

Run: `cd packages/behavior && pnpm vitest run src/config/load.test.ts`
Expected: FAIL — `loadWorkspaceConfig is not exported`

- [ ] **Step 7: loader 実装**

`packages/behavior/src/config/load.ts` — 既存 `loadConfig` の秘密解決部を関数に抽出して共有:

```typescript
import { WORKSPACE_CONFIG_RELPATH, WorkspaceConfigSchema, type WorkspaceConfig } from './schema.js'

/** Resolve db/auth env vars referenced by a config. Missing names are RETURNED, not thrown. */
function resolveSecrets(config: Pick<Config, 'databases' | 'targets'>): {
  secrets: Secrets
  missing: string[]
} {
  const dbSecrets: Record<string, string> = {}
  const targetAuthSecrets: Record<string, string> = {}
  const missing: string[] = []

  for (const db of config.databases) {
    const value = process.env[db.passwordEnv]
    if (!value) missing.push(db.passwordEnv)
    else dbSecrets[db.passwordEnv] = value
  }
  for (const target of config.targets) {
    for (const envName of [target.auth?.usernameEnv, target.auth?.passwordEnv]) {
      if (!envName) continue
      const value = process.env[envName]
      if (!value) missing.push(envName)
      else targetAuthSecrets[envName] = value
    }
  }
  return {
    secrets: {
      db: dbSecrets,
      targetAuth: targetAuthSecrets,
      anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
      githubToken: process.env['GITHUB_TOKEN'] ?? '',
    },
    missing,
  }
}

/**
 * Load .crawl-kit/workspace.yaml. Missing env vars are reported, not fatal —
 * doctor surfaces them and commands that need them fail at point of use.
 */
export async function loadWorkspaceConfig(root: string): Promise<{
  config: WorkspaceConfig
  secrets: Secrets
  missingEnv: string[]
}> {
  dotenv.config({ path: join(root, '.env') })
  const raw = await readYaml<unknown>(join(root, WORKSPACE_CONFIG_RELPATH))
  const config = WorkspaceConfigSchema.parse(raw)
  const { secrets, missing } = resolveSecrets(config)
  return { config, secrets, missingEnv: missing }
}
```

既存 `loadConfig` の重複していた秘密解決ループも `resolveSecrets` を呼ぶ形にリファクタし、**従来どおり missing で throw** する挙動は維持する:

```typescript
export async function loadConfig(root: string): Promise<{ config: Config; secrets: Secrets }> {
  dotenv.config({ path: join(root, '.env') })
  const raw = await readYaml<unknown>(join(root, CONFIG_FILENAME))
  const config = ConfigSchema.parse(raw)
  const { secrets, missing } = resolveSecrets(config)
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
  return { config, secrets }
}
```

`packages/behavior/src/index.ts` に `WorkspaceConfigSchema` / `WorkspaceConfig` / `WorkspaceRepository` / `RepoSetupSchema` / `RepoSetup` / `WORKSPACE_CONFIG_RELPATH` / `loadWorkspaceConfig` / `createDbAdapter`（`./services/db/index.js` から）のエクスポートを追加。既にエクスポート済みのものは重複させない（実装時に `grep "export" packages/behavior/src/index.ts` で確認）。

- [ ] **Step 8: テストが通ることを確認**

Run: `cd packages/behavior && pnpm vitest run src/config/`
Expected: PASS（既存の loadConfig テスト含む）

- [ ] **Step 9: コミット**

```bash
git add packages/behavior/src/config/schema.ts packages/behavior/src/config/schema.test.ts packages/behavior/src/config/load.ts packages/behavior/src/config/load.test.ts packages/behavior/src/index.ts
git commit -m "feat(behavior): workspace.yaml + repos/*.yaml schemas and non-throwing loader"
```

---

### Task 5: cli — テスト基盤 + `setup` コマンド（scaffold / clone / 対話）

**Files:**
- Modify: `packages/cli/package.json`（vitest devDep + `"test": "vitest run"` 追加）
- Create: `packages/cli/src/commands/setup.ts`
- Create: `packages/cli/src/commands/prompt.ts`
- Test: `packages/cli/src/commands/setup.test.ts`

**Interfaces:**
- Consumes: `workspaceConfigPath` / `crawlKitPath` / `CRAWL_KIT_DIR`（contract）、`WorkspaceConfigSchema` / `type WorkspaceConfig`（behavior）、`writeYaml` / `readYaml` は cli 内に小さく再実装（behavior の util は deep import になるため）: `packages/cli/src/commands/yaml-io.ts` として Create
- Produces:
  - `prompt.ts`: `type Prompter = (question: string) => Promise<string>`、`makeReadlinePrompter(): Prompter`
  - `setup.ts`:
    - `cmdSetup(args: string[], deps?: SetupDeps): Promise<void>` — CLI エントリ
    - `type SetupDeps = { prompter?: Prompter; clone?: (url: string, dest: string, branch?: string) => void }`
    - `scaffoldWorkspace(root: string): Promise<void>` — `.crawl-kit/` + workspace.yaml 雛形（存在すれば何もしない・冪等）
    - `cloneMissingRepos(root: string, config: WorkspaceConfig, clone: CloneFn): Promise<string[]>` — path（default name）が無い repo を clone、clone した名前を返す
    - `collectRepositoriesInteractive(prompter: Prompter): Promise<WorkspaceRepository[]>` — URL を空入力まで受け付け、name は URL 末尾（`.git` 除去）から導出。role/audience を尋ねる（空 Enter で backend/user）
- 動作仕様:
  - `crawl-kit setup [dir]` — dir 省略時は cwd。`.crawl-kit/workspace.yaml` が無ければ対話で repositories を収集して生成。既にあれば読み込み、未クローンの repo を `git clone`（`spawnSync("git", ["clone", ...])`、branch 指定時は `--branch <branch>`）
  - workspace.yaml 雛形には `repositories` と、コメントで targets/databases/auth の書き方例を含める
  - このタスクでは repo 分析（repos/*.yaml 生成）はまだ呼ばない（Task 6 で結線）

- [ ] **Step 1: cli にテスト基盤を入れる**

`packages/cli/package.json` の scripts に `"test": "vitest run"`、devDependencies に `"vitest": "^3.0.0"`（root の他パッケージと同じメジャーに合わせる — `grep '"vitest"' packages/*/package.json` で確認して揃える）。Run: `pnpm install`

- [ ] **Step 2: 失敗するテストを書く**

`packages/cli/src/commands/setup.test.ts`:

```typescript
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffoldWorkspace, cloneMissingRepos, collectRepositoriesInteractive } from "./setup.js";
import { WorkspaceConfigSchema } from "@crawl-kit/behavior";

describe("setup", () => {
  it("scaffoldWorkspace creates .crawl-kit/workspace.yaml once (idempotent)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-setup-"));
    await scaffoldWorkspace(root);
    const cfg = join(root, ".crawl-kit", "workspace.yaml");
    expect(existsSync(cfg)).toBe(true);
    const first = await readFile(cfg, "utf8");
    await scaffoldWorkspace(root); // second run must not overwrite
    expect(await readFile(cfg, "utf8")).toBe(first);
  });

  it("cloneMissingRepos clones only repos whose path is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-clone-"));
    await mkdir(join(root, "frontend"), { recursive: true }); // already cloned
    const config = WorkspaceConfigSchema.parse({
      repositories: [
        { name: "backend", label: "BE", url: "https://example.com/be.git", role: "backend", audience: "user" },
        { name: "frontend", label: "FE", url: "https://example.com/fe.git", role: "frontend", audience: "user" },
      ],
    });
    const calls: Array<{ url: string; dest: string }> = [];
    const cloned = await cloneMissingRepos(root, config, (url, dest) => {
      calls.push({ url, dest });
    });
    expect(cloned).toEqual(["backend"]);
    expect(calls).toEqual([{ url: "https://example.com/be.git", dest: join(root, "backend") }]);
  });

  it("collectRepositoriesInteractive derives names from urls and stops on empty input", async () => {
    const answers = ["https://example.com/my-app.git", "", "", "", ""];
    // answers: url1, role(default backend), audience(default user), url2(empty → stop)
    const prompter = async () => answers.shift() ?? "";
    const repos = await collectRepositoriesInteractive(prompter);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ name: "my-app", role: "backend", audience: "user" });
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd packages/cli && pnpm vitest run src/commands/setup.test.ts`
Expected: FAIL — `Cannot find module './setup.js'`

- [ ] **Step 4: 実装**

`packages/cli/src/commands/yaml-io.ts`:

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

export async function readYamlFile<T>(path: string): Promise<T> {
  return parse(await readFile(path, "utf8")) as T;
}

export async function writeYamlFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(data), "utf8");
}
```

（`yaml` を `packages/cli/package.json` の devDependencies に追加 — bundle されるので runtime dep 不要。`"yaml": "^2.6.0"` — behavior の指定に合わせる。）

`packages/cli/src/commands/prompt.ts`:

```typescript
import { createInterface } from "node:readline/promises";

export type Prompter = (question: string) => Promise<string>;

/** Real stdin prompter. Kept behind a type so tests inject a scripted one. */
export function makeReadlinePrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return async (question: string) => (await rl.question(question)).trim();
}
```

`packages/cli/src/commands/setup.ts`:

```typescript
// crawl-kit setup [dir]
//
// Initializes a workspace: .crawl-kit/workspace.yaml, clones the configured
// repositories, then (Task 6) analyzes each repo into .crawl-kit/repos/<name>.yaml.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { workspaceConfigPath } from "@crawl-kit/contract";
import {
  WorkspaceConfigSchema,
  type WorkspaceConfig,
  type WorkspaceRepository,
} from "@crawl-kit/behavior";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { makeReadlinePrompter, type Prompter } from "./prompt.js";

export type CloneFn = (url: string, dest: string, branch?: string) => void;

export type SetupDeps = {
  prompter?: Prompter;
  clone?: CloneFn;
};

function gitClone(url: string, dest: string, branch?: string): void {
  const args = ["clone", ...(branch ? ["--branch", branch] : []), url, dest];
  const r = spawnSync("git", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`git clone failed for ${url}`);
}

/** Derive a repo name from its clone URL: last path segment minus ".git". */
export function repoNameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, "").split("/").pop() ?? "repo";
  return last.replace(/\.git$/, "");
}

export async function scaffoldWorkspace(root: string): Promise<void> {
  const cfg = workspaceConfigPath(root);
  if (existsSync(cfg)) return;
  await writeYamlFile(cfg, { repositories: [] });
}

export async function collectRepositoriesInteractive(prompter: Prompter): Promise<WorkspaceRepository[]> {
  const repos: WorkspaceRepository[] = [];
  for (;;) {
    const url = await prompter(`repo #${repos.length + 1} の git URL（空 Enter で終了): `);
    if (!url) break;
    const name = repoNameFromUrl(url);
    const role = (await prompter("role [backend/frontend] (backend): ")) || "backend";
    const audience = (await prompter("audience [user/admin] (user): ")) || "user";
    repos.push({
      name,
      label: name,
      url,
      role: role === "frontend" ? "frontend" : "backend",
      audience: audience === "admin" ? "admin" : "user",
    });
  }
  return repos;
}

/** Clone every configured repo whose local path doesn't exist yet. Returns cloned names. */
export async function cloneMissingRepos(
  root: string,
  config: WorkspaceConfig,
  clone: CloneFn = gitClone,
): Promise<string[]> {
  const cloned: string[] = [];
  for (const repo of config.repositories) {
    const dest = join(root, repo.path ?? repo.name);
    if (existsSync(dest)) continue;
    clone(repo.url, dest, repo.branch);
    cloned.push(repo.name);
  }
  return cloned;
}

export async function cmdSetup(args: string[], deps: SetupDeps = {}): Promise<void> {
  const root = resolve(args.find((a) => !a.startsWith("-")) ?? process.cwd());
  const prompter = deps.prompter ?? makeReadlinePrompter();

  await scaffoldWorkspace(root);
  const cfgPath = workspaceConfigPath(root);
  const raw = await readYamlFile<{ repositories?: unknown[] }>(cfgPath);

  if (!raw.repositories || raw.repositories.length === 0) {
    console.log("workspace.yaml に repositories がありません。対話で登録します。");
    const repos = await collectRepositoriesInteractive(prompter);
    if (repos.length === 0) throw new Error("リポジトリが1つも登録されていません");
    await writeYamlFile(cfgPath, { ...raw, repositories: repos });
  }

  const config = WorkspaceConfigSchema.parse(await readYamlFile<unknown>(cfgPath));
  const cloned = await cloneMissingRepos(root, config, deps.clone);
  console.log(
    cloned.length
      ? `cloned: ${cloned.join(", ")}`
      : "すべてのリポジトリはクローン済みです",
  );
  console.log(`workspace: ${root}`);
}
```

注意: `collectRepositoriesInteractive` のテストは url→role→audience の順で 1 repo 分に 3 回 prompter が呼ばれる想定。テストの answers 配列コメントと一致させること。

- [ ] **Step 5: テストが通ることを確認**

Run: `cd packages/cli && pnpm vitest run src/commands/setup.test.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/cli/package.json packages/cli/src/commands/ pnpm-lock.yaml
git commit -m "feat(cli): setup command — workspace scaffold, interactive repo registry, clone"
```

---

### Task 6: cli — setup のリポジトリ分析（repos/<name>.yaml 生成）

**Files:**
- Create: `packages/cli/src/commands/repo-analysis.ts`
- Modify: `packages/cli/src/commands/setup.ts`（分析の結線）
- Modify: `packages/structure/src/index.ts`（`detectFrameworks` と `getProvider` のエクスポート追加）
- Test: `packages/cli/src/commands/repo-analysis.test.ts`

**Interfaces:**
- Consumes:
  - `detectFrameworks(manifestSnippets: Record<string, string>): string[]`（`packages/structure/src/analyze/context/knowledge.ts:37` — index.ts から再エクスポートする）
  - `getProvider(env?): LlmProvider | null`（`packages/structure/src/analyze/llm/provider.ts:40` — 同上。`provider.analyzeCodebase?(path, prompt)` を任意利用）
  - `RepoSetupSchema` / `type RepoSetup`（behavior・Task 4）、`repoConfigPath`（contract・Task 2）
  - `Prompter`（Task 5）
- Produces:
  - `analyzeRepoForSetup(repoPath: string, deps?: AnalysisDeps): Promise<RepoSetup>` — ヒューリスティクス + （あれば）LLM + 不明項目のユーザー確認
  - `type AnalysisDeps = { prompter?: Prompter; llm?: { analyzeCodebase?(path: string, prompt: string): Promise<string> } | null }`
  - `writeRepoSetup(root: string, name: string, setup: RepoSetup): Promise<void>` — `repos/<name>.yaml` へ保存（既存があれば既存値優先でマージ = 冪等）
- 分析ロジック（優先順位順）:
  1. `CLAUDE.md` があれば先頭 4000 文字を structure.summary の素材にし `claudeMd: { present: true, source: "claude-md" }`
  2. マニフェスト（`package.json` / `composer.json` / `Gemfile` / `go.mod` / `pom.xml` / `build.gradle` / `Cargo.toml`）を読んで `detectFrameworks` → framework（検出なしは `"generic"`）
  3. devServer: `package.json` の `scripts.dev` → `npm run dev` / `composer.json` + `artisan` 存在 → `php artisan serve` / `docker-compose*.yml` があれば `composeFile` に記録
  4. dbAccess: `.env.example` に `DB_` 系キーがあれば `source: ".env", envFile: ".env"`
  5. summary が空 かつ `deps.llm?.analyzeCodebase` があれば LLM に「このリポジトリのルーティング/コントローラ/モデルのディレクトリ構造を3行で要約」と依頼
  6. それでも devServer / dbAccess が不明なら prompter でユーザーに確認（空 Enter でスキップ = undefined のまま、`claudeMd.source` は入力があれば `"user"`）

- [ ] **Step 1: structure のエクスポート追加**

`packages/structure/src/index.ts` に追記:

```typescript
export { detectFrameworks } from "./analyze/context/knowledge.js";
export { getProvider, type LlmProvider } from "./analyze/llm/provider.js";
```

Run: `cd packages/structure && pnpm lint`
Expected: エラーなし

- [ ] **Step 2: 失敗するテストを書く**

`packages/cli/src/commands/repo-analysis.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRepoForSetup, writeRepoSetup } from "./repo-analysis.js";

const noPrompt = async () => "";

describe("analyzeRepoForSetup", () => {
  it("detects a node repo with a dev script and compose file", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev" } }),
      "utf8",
    );
    await writeFile(join(repo, "docker-compose.yml"), "services: {}\n", "utf8");
    await writeFile(join(repo, ".env.example"), "DB_HOST=localhost\nDB_PORT=5432\n", "utf8");
    const setup = await analyzeRepoForSetup(repo, { prompter: noPrompt, llm: null });
    expect(setup.devServer?.command).toBe("npm run dev");
    expect(setup.devServer?.composeFile).toBe("docker-compose.yml");
    expect(setup.dbAccess).toEqual({ source: ".env", envFile: ".env" });
    expect(setup.claudeMd).toEqual({ present: false, source: "auto-analysis" });
  });

  it("prefers CLAUDE.md as the structure summary source", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    await writeFile(join(repo, "CLAUDE.md"), "# App\nRoutes live in src/routes.\n", "utf8");
    const setup = await analyzeRepoForSetup(repo, { prompter: noPrompt, llm: null });
    expect(setup.claudeMd).toEqual({ present: true, source: "claude-md" });
    expect(setup.structure.summary).toContain("Routes live in src/routes.");
  });

  it("asks the user when devServer is unknown and records their answer", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    const answers = ["make server", ""];
    const setup = await analyzeRepoForSetup(repo, {
      prompter: async () => answers.shift() ?? "",
      llm: null,
    });
    expect(setup.devServer?.command).toBe("make server");
    expect(setup.claudeMd.source).toBe("user");
  });

  it("uses the LLM summary when heuristics find nothing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    const setup = await analyzeRepoForSetup(repo, {
      prompter: noPrompt,
      llm: { analyzeCodebase: async () => "routes in app/, controllers in app/Http" },
    });
    expect(setup.structure.summary).toBe("routes in app/, controllers in app/Http");
  });
});

describe("writeRepoSetup", () => {
  it("writes repos/<name>.yaml and keeps existing values on re-run", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-ra-ws-"));
    await writeRepoSetup(root, "be", {
      framework: "laravel",
      structure: { summary: "s1", routingDirs: [], controllerDirs: [], modelDirs: [] },
      devServer: { command: "php artisan serve" },
      claudeMd: { present: false, source: "auto-analysis" },
    });
    // second write with a different summary must NOT clobber the existing one
    await writeRepoSetup(root, "be", {
      framework: "generic",
      structure: { summary: "s2", routingDirs: [], controllerDirs: [], modelDirs: [] },
      claudeMd: { present: false, source: "auto-analysis" },
    });
    const text = await readFile(join(root, ".crawl-kit", "repos", "be.yaml"), "utf8");
    expect(text).toContain("s1");
    expect(text).toContain("laravel");
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd packages/cli && pnpm vitest run src/commands/repo-analysis.test.ts`
Expected: FAIL — `Cannot find module './repo-analysis.js'`

- [ ] **Step 4: 実装**

`packages/cli/src/commands/repo-analysis.ts`:

```typescript
// Repo analysis for `crawl-kit setup`: figure out framework / structure /
// dev-server / db-access per repo. Heuristics first, LLM when available,
// the user as the last resort — and record where each answer came from.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { repoConfigPath } from "@crawl-kit/contract";
import { RepoSetupSchema, type RepoSetup } from "@crawl-kit/behavior";
import { detectFrameworks } from "@crawl-kit/structure";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import type { Prompter } from "./prompt.js";

export type AnalysisDeps = {
  prompter?: Prompter;
  llm?: { analyzeCodebase?(path: string, prompt: string): Promise<string> } | null;
};

const MANIFESTS = ["package.json", "composer.json", "Gemfile", "go.mod", "pom.xml", "build.gradle", "Cargo.toml"];

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function detectFramework(repoPath: string): Promise<string> {
  const snippets: Record<string, string> = {};
  for (const m of MANIFESTS) {
    const text = await readIfExists(join(repoPath, m));
    if (text !== null) snippets[m] = text.slice(0, 4000);
  }
  const found = detectFrameworks(snippets);
  return found[0] ?? "generic";
}

async function detectDevServer(repoPath: string): Promise<RepoSetup["devServer"]> {
  const entries = await readdir(repoPath).catch(() => [] as string[]);
  const composeFile = entries.find((e) => /^docker-compose.*\.ya?ml$/.test(e));
  const pkg = await readIfExists(join(repoPath, "package.json"));
  if (pkg) {
    const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
    if (scripts["dev"]) return { command: "npm run dev", ...(composeFile ? { composeFile } : {}) };
  }
  if (existsSync(join(repoPath, "artisan"))) {
    return { command: "php artisan serve", ...(composeFile ? { composeFile } : {}) };
  }
  return composeFile ? { command: `docker compose -f ${composeFile} up`, composeFile } : undefined;
}

async function detectDbAccess(repoPath: string): Promise<RepoSetup["dbAccess"]> {
  const envExample = await readIfExists(join(repoPath, ".env.example"));
  if (envExample && /^DB_/m.test(envExample)) return { source: ".env", envFile: ".env" };
  return undefined;
}

export async function analyzeRepoForSetup(repoPath: string, deps: AnalysisDeps = {}): Promise<RepoSetup> {
  const prompter = deps.prompter ?? (async () => "");
  const claudeMdText = await readIfExists(join(repoPath, "CLAUDE.md"));

  const framework = await detectFramework(repoPath);
  let devServer = await detectDevServer(repoPath);
  let dbAccess = await detectDbAccess(repoPath);
  let summary = claudeMdText ? claudeMdText.slice(0, 4000) : "";

  if (!summary && deps.llm?.analyzeCodebase) {
    summary = (
      await deps.llm.analyzeCodebase(
        repoPath,
        "このリポジトリのルーティング定義・コントローラ・モデルがどのディレクトリにあるか3行で要約してください。",
      )
    ).trim();
  }

  let userAnswered = false;
  if (!devServer) {
    const answer = await prompter("開発環境の起動コマンドは?（例: npm run dev。空 Enter でスキップ): ");
    if (answer) {
      devServer = { command: answer };
      userAnswered = true;
    }
  }
  if (!dbAccess) {
    const answer = await prompter("DB接続情報の取得元は?（例: .env。空 Enter でスキップ): ");
    if (answer) {
      dbAccess = { source: answer };
      userAnswered = true;
    }
  }

  return RepoSetupSchema.parse({
    framework,
    structure: { summary, routingDirs: [], controllerDirs: [], modelDirs: [] },
    ...(devServer ? { devServer } : {}),
    ...(dbAccess ? { dbAccess } : {}),
    claudeMd: {
      present: claudeMdText !== null,
      source: claudeMdText !== null ? "claude-md" : userAnswered ? "user" : "auto-analysis",
    },
  });
}

/** Write repos/<name>.yaml. Existing values win — setup re-runs must not clobber
 *  human edits. */
export async function writeRepoSetup(root: string, name: string, setup: RepoSetup): Promise<void> {
  const path = repoConfigPath(root, name);
  const existing = existsSync(path) ? await readYamlFile<Partial<RepoSetup>>(path) : {};
  const merged = RepoSetupSchema.parse({ ...setup, ...existing });
  await writeYamlFile(path, merged);
}
```

`packages/cli/src/commands/setup.ts` の `cmdSetup` 末尾（clone 後）に結線:

```typescript
  const { getProvider } = await import("@crawl-kit/structure");
  const provider = getProvider();
  for (const repo of config.repositories) {
    const repoPath = join(root, repo.path ?? repo.name);
    const setup = await analyzeRepoForSetup(repoPath, {
      prompter,
      llm: provider?.analyzeCodebase ? { analyzeCodebase: (p, q) => provider.analyzeCodebase!(p, q) } : null,
    });
    await writeRepoSetup(root, repo.name, setup);
    console.log(`analyzed: ${repo.name} (framework=${setup.framework})`);
  }
```

（`import { analyzeRepoForSetup, writeRepoSetup } from "./repo-analysis.js";` をファイル先頭に追加。）

- [ ] **Step 5: テストが通ることを確認**

Run: `cd packages/cli && pnpm vitest run`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/structure/src/index.ts packages/cli/src/commands/repo-analysis.ts packages/cli/src/commands/repo-analysis.test.ts packages/cli/src/commands/setup.ts
git commit -m "feat(cli): setup analyzes each repo into .crawl-kit/repos/<name>.yaml"
```

---

### Task 7: cli — `doctor` コマンド（プリフライト）

**Files:**
- Create: `packages/cli/src/commands/doctor.ts`
- Test: `packages/cli/src/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `findWorkspaceRoot`（contract）、`loadWorkspaceConfig` / `createDbAdapter` / `type WorkspaceConfig`（behavior）
- Produces:
  - `type DoctorCheck = { id: string; label: string; ok: boolean; detail: string; fixHint?: string; blocks: "intent" | "structure" | "behavior" | null }`
  - `runDoctor(root: string, deps?: DoctorDeps): Promise<DoctorCheck[]>` — P2 の `run` がプリフライトとして再利用する
  - `type DoctorDeps = { dbFactory?: typeof createDbAdapter; fetchFn?: typeof fetch; which?: (cmd: string) => boolean }`
  - `blockedPhases(checks: DoctorCheck[]): Map<"intent" | "structure" | "behavior", string>` — フェーズ→ブロック理由（P2 が progress.json へ記録するのに使う）
  - `cmdDoctor(args: string[]): Promise<void>` — 表を表示し、blocking な失敗があれば `process.exitCode = 1`
- チェック一覧（`blocks` 列はスペック B 節の表に対応）:

| id | 方法 | blocks |
|---|---|---|
| `workspace` | `findWorkspaceRoot()` が非 null | すべて（null なら他チェックはスキップし即 return） |
| `distill-ddd` | `which("distill-ddd")`（`spawnSync("distill-ddd", ["--version"])` status===0） | intent |
| `repo:<name>` | `<root>/<path>/.git` が存在 | structure |
| `env` | `loadWorkspaceConfig().missingEnv` が空 | behavior |
| `db:<name>` | `createDbAdapter(conn, password).query("SELECT 1", [])`（5s timeout、finally close） | behavior |
| `login` | targets[].auth があるとき: strategy!=="none" なら usernameEnv/passwordEnv が resolve 済み、loginUrl/loginPath いずれか存在 | behavior |
| `target:<name>` | `fetchFn(baseUrl, { method: "HEAD" })` が応答（status は問わない、ネットワークエラーのみ NG。catch で GET リトライ） | behavior |
| `playwright` | `createRequire(import.meta.url).resolve("playwright")` が成功（behavior 経由で解決できれば OK: `require.resolve("playwright", { paths: [<root>, here] })` を try） | behavior |

- [ ] **Step 1: 失敗するテストを書く**

`packages/cli/src/commands/doctor.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor, blockedPhases } from "./doctor.js";

async function makeWorkspace(extraYaml = ""): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ck-doc-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(
    join(root, ".crawl-kit", "workspace.yaml"),
    [
      "repositories:",
      '  - { name: be, label: BE, url: "https://example.com/be.git", role: backend, audience: user }',
      extraYaml,
    ].join("\n"),
    "utf8",
  );
  return root;
}

describe("runDoctor", () => {
  it("reports a single failing workspace check outside a workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-nodoc-"));
    const checks = await runDoctor(dir);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: "workspace", ok: false });
  });

  it("flags an uncloned repo as blocking structure", async () => {
    const root = await makeWorkspace();
    const checks = await runDoctor(root, { which: () => true, fetchFn: (async () => new Response()) as typeof fetch });
    const repoCheck = checks.find((c) => c.id === "repo:be")!;
    expect(repoCheck.ok).toBe(false);
    expect(repoCheck.blocks).toBe("structure");
  });

  it("db failure blocks behavior with the error in detail", async () => {
    process.env["CK_DOC_PW"] = "pw";
    const root = await makeWorkspace(
      [
        "databases:",
        "  - { name: main, type: postgres, host: localhost, port: 5432, database: app, user: app, passwordEnv: CK_DOC_PW }",
      ].join("\n"),
    );
    const failingDb = () => ({
      query: async () => {
        throw new Error("ECONNREFUSED");
      },
      close: async () => {},
    });
    const checks = await runDoctor(root, {
      which: () => true,
      fetchFn: (async () => new Response()) as typeof fetch,
      dbFactory: failingDb as never,
    });
    const db = checks.find((c) => c.id === "db:main")!;
    expect(db.ok).toBe(false);
    expect(db.detail).toContain("ECONNREFUSED");
    expect(blockedPhases(checks).get("behavior")).toContain("db:main");
    delete process.env["CK_DOC_PW"];
  });

  it("distill-ddd missing blocks intent only", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, "be", ".git"), { recursive: true });
    const checks = await runDoctor(root, { which: () => false, fetchFn: (async () => new Response()) as typeof fetch });
    const ddd = checks.find((c) => c.id === "distill-ddd")!;
    expect(ddd.ok).toBe(false);
    expect(ddd.blocks).toBe("intent");
    expect(ddd.fixHint).toContain("github.com/tango238/distill-ddd");
    expect(blockedPhases(checks).has("structure")).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd packages/cli && pnpm vitest run src/commands/doctor.test.ts`
Expected: FAIL — `Cannot find module './doctor.js'`

- [ ] **Step 3: 実装**

`packages/cli/src/commands/doctor.ts`:

```typescript
// crawl-kit doctor — preflight checks. Each check knows which pipeline phase
// its failure blocks; `run` (P2) uses blockedPhases() to mark the ledger, and
// the dashboard explains "why is this menu empty" from the same data.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { findWorkspaceRoot } from "@crawl-kit/contract";
import { loadWorkspaceConfig, createDbAdapter } from "@crawl-kit/behavior";

export type BlockablePhase = "intent" | "structure" | "behavior";

export type DoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fixHint?: string;
  blocks: BlockablePhase | null;
};

export type DoctorDeps = {
  dbFactory?: typeof createDbAdapter;
  fetchFn?: typeof fetch;
  which?: (cmd: string) => boolean;
};

const DISTILL_URL = "https://github.com/tango238/distill-ddd";

function defaultWhich(cmd: string): boolean {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

export async function runDoctor(startDir: string, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const which = deps.which ?? defaultWhich;
  const fetchFn = deps.fetchFn ?? fetch;
  const dbFactory = deps.dbFactory ?? createDbAdapter;

  const root = findWorkspaceRoot(startDir);
  if (!root) {
    return [
      {
        id: "workspace",
        label: "workspace",
        ok: false,
        detail: `${startDir} はワークスペース内ではありません`,
        fixHint: "crawl-kit setup <dir> でワークスペースを作成してください",
        blocks: null,
      },
    ];
  }

  const checks: DoctorCheck[] = [
    { id: "workspace", label: "workspace", ok: true, detail: root, blocks: null },
  ];

  const { config, secrets, missingEnv } = await loadWorkspaceConfig(root);

  checks.push({
    id: "distill-ddd",
    label: "distill-ddd CLI",
    ok: which("distill-ddd"),
    detail: which("distill-ddd") ? "found" : "not found",
    fixHint: `インストール: ${DISTILL_URL}`,
    blocks: "intent",
  });

  for (const repo of config.repositories) {
    const dir = join(root, repo.path ?? repo.name);
    const ok = existsSync(join(dir, ".git"));
    checks.push({
      id: `repo:${repo.name}`,
      label: `repo ${repo.name}`,
      ok,
      detail: ok ? dir : `${dir} が未クローン`,
      fixHint: "crawl-kit setup を実行してください",
      blocks: "structure",
    });
  }

  checks.push({
    id: "env",
    label: "env vars",
    ok: missingEnv.length === 0,
    detail: missingEnv.length === 0 ? "all resolved" : `missing: ${missingEnv.join(", ")}`,
    fixHint: ".env または環境変数を設定してください",
    blocks: "behavior",
  });

  for (const db of config.databases) {
    const password = secrets.db[db.passwordEnv];
    if (!password) {
      checks.push({
        id: `db:${db.name}`,
        label: `db ${db.name}`,
        ok: false,
        detail: `${db.passwordEnv} が未設定のため接続確認できません`,
        blocks: "behavior",
      });
      continue;
    }
    const adapter = dbFactory(db, password);
    try {
      await withTimeout(adapter.query("SELECT 1", []), 5000, `db ${db.name}`);
      checks.push({ id: `db:${db.name}`, label: `db ${db.name}`, ok: true, detail: `${db.host}:${db.port}/${db.database}`, blocks: "behavior" });
    } catch (error) {
      checks.push({
        id: `db:${db.name}`,
        label: `db ${db.name}`,
        ok: false,
        detail: (error as Error).message,
        fixHint: "DBを起動し接続情報を確認してください",
        blocks: "behavior",
      });
    } finally {
      await adapter.close().catch(() => {});
    }
  }

  for (const target of config.targets) {
    const auth = target.auth;
    if (auth && auth.strategy !== "none") {
      const loginOk = Boolean(auth.loginUrl || auth.loginPath);
      const credsOk = Boolean(auth.usernameEnv && auth.passwordEnv && secrets.targetAuth[auth.usernameEnv] && secrets.targetAuth[auth.passwordEnv]);
      checks.push({
        id: `login:${target.name}`,
        label: `login ${target.name}`,
        ok: loginOk && credsOk,
        detail: loginOk && credsOk ? "configured" : `loginUrl/loginPath=${loginOk}, credentials=${credsOk}`,
        fixHint: "workspace.yaml の auth と ID/Pass 環境変数を設定してください",
        blocks: "behavior",
      });
    }
    let reachable = true;
    let detail = target.baseUrl;
    try {
      await withTimeout(fetchFn(target.baseUrl, { method: "HEAD" }), 5000, `target ${target.name}`);
    } catch {
      try {
        await withTimeout(fetchFn(target.baseUrl), 5000, `target ${target.name}`);
      } catch (error) {
        reachable = false;
        detail = (error as Error).message;
      }
    }
    checks.push({
      id: `target:${target.name}`,
      label: `target ${target.name}`,
      ok: reachable,
      detail,
      fixHint: "対象アプリを起動してください（launch 設定があれば behavior init）",
      blocks: "behavior",
    });
  }

  const require = createRequire(import.meta.url);
  let playwrightOk = true;
  try {
    require.resolve("playwright", { paths: [root, import.meta.dirname ?? "."] });
  } catch {
    playwrightOk = false;
  }
  checks.push({
    id: "playwright",
    label: "playwright",
    ok: playwrightOk,
    detail: playwrightOk ? "resolvable" : "not installed",
    fixHint: "pnpm add -D playwright && npx playwright install chromium",
    blocks: "behavior",
  });

  return checks;
}

/** Phase → human-readable reason, from every failing blocking check. */
export function blockedPhases(checks: DoctorCheck[]): Map<BlockablePhase, string> {
  const map = new Map<BlockablePhase, string>();
  for (const c of checks) {
    if (c.ok || !c.blocks) continue;
    const prev = map.get(c.blocks);
    const entry = `${c.id}: ${c.detail}`;
    map.set(c.blocks, prev ? `${prev}; ${entry}` : entry);
  }
  return map;
}

export async function cmdDoctor(_args: string[]): Promise<void> {
  const checks = await runDoctor(process.cwd());
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    console.log(`${mark} ${c.label.padEnd(24)} ${c.detail}${!c.ok && c.fixHint ? `\n    → ${c.fixHint}` : ""}`);
  }
  const blocked = blockedPhases(checks);
  if (blocked.size > 0) {
    console.log("\nブロックされるフェーズ:");
    for (const [phase, reason] of blocked) console.log(`  ${phase}: ${reason}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd packages/cli && pnpm vitest run src/commands/doctor.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/commands/doctor.ts packages/cli/src/commands/doctor.test.ts
git commit -m "feat(cli): doctor preflight — phase-aware blocking checks"
```

---

### Task 8: cli — `migrate` コマンド（レガシー → ワークスペース）

**Files:**
- Create: `packages/cli/src/commands/migrate.ts`
- Test: `packages/cli/src/commands/migrate.test.ts`

**Interfaces:**
- Consumes: `workspaceConfigPath` / `findWorkspaceRoot`（contract）、`ConfigSchema`（behavior — legacy 検証用）、`readYamlFile` / `writeYamlFile`（Task 5）
- Produces: `cmdMigrate(args: string[]): Promise<void>`、`migrateLegacy(root: string): Promise<{ converted: boolean }>`
- 動作仕様: 既存リポジトリのルート（`e2e.config.yaml` があり `data/` がある想定）で実行すると:
  1. 既に workspace なら何もしない（converted: false）
  2. `e2e.config.yaml` を読み、そのまま `.crawl-kit/workspace.yaml` として書き出す（WorkspaceConfigSchema は ConfigSchema のスーパーセットなので追加変換不要。`repositories[].path` は既存レガシーではリポジトリ自身なので、リポジトリ root がワークスペース root になる場合 `path: "."` を全 repo に付与）
  3. `data/` はリポジトリ root 直下にあるためそのまま有効（workspace root = repo root）。移動不要であることを検証（`findWorkspaceRoot` が root を返し `dataPath` が同じ場所を指す）
  4. `e2e.config.yaml` は残す（behavior の legacy loader 用。コンソールに「workspace.yaml が今後の正とする」旨を表示）

- [ ] **Step 1: 失敗するテストを書く**

`packages/cli/src/commands/migrate.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacy } from "./migrate.js";

const LEGACY_YAML = [
  "repositories:",
  '  - { name: be, label: BE, url: "https://example.com/be.git", role: backend, audience: user }',
  "targets:",
  '  - { name: app, baseUrl: "http://localhost:3000" }',
  "databases: []",
  "schedule: { intervalMinutes: 60 }",
  "scenarioDir: scenarios",
  "github: { labels: { ready: ready, autoDetect: auto } }",
].join("\n");

describe("migrateLegacy", () => {
  it("converts e2e.config.yaml into .crawl-kit/workspace.yaml with path: '.'", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-mig-"));
    await writeFile(join(root, "e2e.config.yaml"), LEGACY_YAML, "utf8");
    await mkdir(join(root, "data"), { recursive: true });
    const { converted } = await migrateLegacy(root);
    expect(converted).toBe(true);
    expect(existsSync(join(root, ".crawl-kit", "workspace.yaml"))).toBe(true);
    const text = await readFile(join(root, ".crawl-kit", "workspace.yaml"), "utf8");
    expect(text).toContain("path: .");
    expect(existsSync(join(root, "e2e.config.yaml"))).toBe(true); // kept
  });

  it("is a no-op inside an existing workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-mig2-"));
    await mkdir(join(root, ".crawl-kit"), { recursive: true });
    await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
    const { converted } = await migrateLegacy(root);
    expect(converted).toBe(false);
  });

  it("throws when there is nothing to migrate", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-mig3-"));
    await expect(migrateLegacy(root)).rejects.toThrow(/e2e.config.yaml/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd packages/cli && pnpm vitest run src/commands/migrate.test.ts`
Expected: FAIL — `Cannot find module './migrate.js'`

- [ ] **Step 3: 実装**

`packages/cli/src/commands/migrate.ts`:

```typescript
// crawl-kit migrate — adopt an existing per-repo layout (e2e.config.yaml +
// data/ at the repo root) as a workspace: the repo root BECOMES the workspace
// root, so data/ stays where it is and only the config moves under .crawl-kit/.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findWorkspaceRoot, workspaceConfigPath } from "@crawl-kit/contract";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";

type LegacyConfig = { repositories?: Array<Record<string, unknown>> } & Record<string, unknown>;

export async function migrateLegacy(root: string): Promise<{ converted: boolean }> {
  if (findWorkspaceRoot(root) === root) return { converted: false };
  const legacyPath = join(root, "e2e.config.yaml");
  if (!existsSync(legacyPath)) {
    throw new Error(`${root} に e2e.config.yaml がありません — 移行対象ではありません`);
  }
  const legacy = await readYamlFile<LegacyConfig>(legacyPath);
  const repositories = (legacy.repositories ?? []).map((r) => ({ ...r, path: "." }));
  await writeYamlFile(workspaceConfigPath(root), { ...legacy, repositories });
  return { converted: true };
}

export async function cmdMigrate(args: string[]): Promise<void> {
  const root = resolve(args.find((a) => !a.startsWith("-")) ?? process.cwd());
  const { converted } = await migrateLegacy(root);
  console.log(
    converted
      ? `migrated: ${workspaceConfigPath(root)} を作成しました（今後はこちらが正。e2e.config.yaml は残置）`
      : "既にワークスペースです — 何もしていません",
  );
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd packages/cli && pnpm vitest run src/commands/migrate.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/commands/migrate.ts packages/cli/src/commands/migrate.test.ts
git commit -m "feat(cli): migrate legacy e2e.config.yaml layout into a workspace"
```

---

### Task 9: cli — dispatch 配線 + HELP + ビルド/リンタ/全テスト

**Files:**
- Modify: `packages/cli/src/index.ts`（import + switch + HELP 文言）
- Modify: `README.md`（setup / doctor / migrate の節を追加）

**Interfaces:**
- Consumes: `cmdSetup`（Task 5）、`cmdDoctor`（Task 7）、`cmdMigrate`（Task 8）
- Produces: `crawl-kit setup|doctor|migrate` が動く CLI

- [ ] **Step 1: dispatch へ配線**

`packages/cli/src/index.ts` の import 部に追加:

```typescript
import { cmdSetup } from "./commands/setup.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdMigrate } from "./commands/migrate.js";
```

`main()` の switch に追加（`case "demo":` の直後）:

```typescript
    case "setup": return cmdSetup(args);
    case "doctor": return cmdDoctor(args);
    case "migrate": return cmdMigrate(args);
```

HELP 文字列のコマンド一覧に追記:

```
  setup [dir]          ワークスペース初期化: git clone + .crawl-kit/ 生成（対話）
  doctor               プリフライト: distill-ddd / repo / DB / ログイン / target / playwright
  migrate [dir]        既存の e2e.config.yaml + data/ 運用をワークスペースへ移行
```

- [ ] **Step 2: 型チェック・全テスト・バンドルの確認**

Run（repo root）:
```bash
pnpm -r lint && pnpm -r test && pnpm --filter @tanago3/crawl-kit build
```
Expected: すべて成功。esbuild bundle が `yaml` を含めて解決できること（失敗する場合は `packages/cli/package.json` の devDependencies に `yaml` が入っているか確認）

- [ ] **Step 3: スモークテスト（実 CLI）**

```bash
cd "$(mktemp -d)" && node /Users/go/work/github/crawl-kit/packages/cli/dist/index.js doctor; echo "exit=$?"
```
Expected: `✗ workspace ...`（ワークスペース外の案内）が表示され exit=0（blocks:null のため）

- [ ] **Step 4: README 更新**

`README.md` のコマンド一覧に setup / doctor / migrate を追記（HELP と同文言 + ワークスペースのディレクトリ図はスペック A 節から転記）。

- [ ] **Step 5: コミット**

```bash
git add packages/cli/src/index.ts README.md
git commit -m "feat(cli): wire setup/doctor/migrate + workspace docs"
```

---

## Self-Review 結果（プラン作成時に実施済み）

- **スペック網羅**: スペック A 節（ワークスペース/ setup）→ Task 2,4,5,6。B 節（doctor）→ Task 7。進捗台帳スキーマ（C 節の progress.json）→ Task 3。migrate（A 節パス解決）→ Task 8。C 節の run オーケストレータ / viewer 起動 / resume は **P2 プランのスコープ**（本プランの `runDoctor`・`blockedPhases`・progress 純関数群が P2 の入力インターフェース）。
- **型整合**: `WorkspaceConfig`（Task 4）を Task 5/7 が consume。`RepoSetup`（Task 4）を Task 6 が consume。`Prompter`（Task 5）を Task 6 が consume。`DoctorCheck`/`blockedPhases`（Task 7）は P2 へのインターフェース。
- **並列実行**: Task 1→2→3 は contract 内で直列。Task 4 は Task 1-3 と独立に並列可。Task 5 は Task 2+4 の後。Task 6 は Task 4+5 の後。Task 7 は Task 2+4 の後（Task 5/6 と並列可）。Task 8 は Task 2+4 の後（Task 5-7 と並列可）。Task 9 は最後。最大並列 3 を超えない組: {1→2→3} ∥ {4} → {5→6} ∥ {7} ∥ {8} → {9}。
