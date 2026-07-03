import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  progressPath,
  readProgressOrEmpty,
  withPhaseStatus,
  writeProgress,
  type Progress,
} from "@crawl-kit/contract";
import type { DoctorCheck } from "./doctor.js";
import type { Viewer } from "./serve.js";
import { cmdRunWorkspace, type RunDeps, type StructureHooks } from "./run.js";

async function makeWorkspace(opts: { intentJson?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ck-run-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(
    join(root, ".crawl-kit", "workspace.yaml"),
    [
      "repositories:",
      '  - { name: be, label: BE, url: "https://example.com/be.git", role: backend, audience: user, path: be }',
      "targets:",
      '  - { name: app, baseUrl: "http://localhost:3000" }',
    ].join("\n"),
    "utf8",
  );
  // one real file so enumerateUnits(be) sees exactly 1 (generic) unit → structure total = 1 * 3 = 3
  await mkdir(join(root, "be"), { recursive: true });
  await writeFile(join(root, "be", "index.js"), "export const a = 1;\n", "utf8");

  if (opts.intentJson !== false) {
    await mkdir(join(root, "docs", "domain"), { recursive: true });
    await writeFile(
      join(root, "docs", "domain", "intent.json"),
      JSON.stringify({ concepts: [{ name: "Order", attributes: [] }] }),
      "utf8",
    );
  }
  return root;
}

const okDoctor = async (): Promise<DoctorCheck[]> => [];
const fakeViewer = async (): Promise<Viewer> => ({
  port: 4317,
  urls: ["http://localhost:4317/"],
  close: async () => {},
});

/** fake analyzeStructureRepo: fires onUnit exactly 3 times, one per (fake) pass. */
async function threeUnitFake(_repoPath: string, hooks: StructureHooks): Promise<void> {
  await hooks.onUnit?.(1, "generic:.", 1, 1);
  await hooks.onUnit?.(2, "generic:.", 1, 1);
  await hooks.onUnit?.(3, "generic:.", 1, 1);
}

function baseDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    html: "<html></html>",
    reconcile: async () => {},
    verify: async () => {},
    analyzeStructureRepo: threeUnitFake,
    runBehavior: async () => ({ ok: true, crawledPages: 2 }),
    doctor: okDoctor,
    viewer: fakeViewer,
    ...overrides,
  };
}

async function runFrom(cwd: string, args: string[], deps: RunDeps): Promise<void> {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    await cmdRunWorkspace(args, deps);
  } finally {
    process.chdir(prev);
  }
}

async function readProgress(root: string): Promise<Progress> {
  return readProgressOrEmpty(progressPath(root), "read");
}

describe("cmdRunWorkspace", () => {
  it("1. normal run: all five phases complete, structure tasks reach 3/3", async () => {
    const root = await makeWorkspace();
    await runFrom(root, [], baseDeps());
    const progress = await readProgress(root);
    expect(progress.phases.intent.status).toBe("completed");
    expect(progress.phases.structure.status).toBe("completed");
    expect(progress.phases.behavior.status).toBe("completed");
    expect(progress.phases.reconcile.status).toBe("completed");
    expect(progress.phases.verify.status).toBe("completed");
    expect(progress.phases.structure.tasks.completed).toBe(3);
    expect(progress.phases.structure.tasks.total).toBe(3);
  });

  it("2. doctor blocks behavior: behavior blocked with reason, other phases still complete", async () => {
    const root = await makeWorkspace();
    const doctor = async (): Promise<DoctorCheck[]> => [
      { id: "db:main", label: "db main", ok: false, detail: "ECONNREFUSED", blocks: "behavior" },
    ];
    await runFrom(root, [], baseDeps({ doctor }));
    const progress = await readProgress(root);
    expect(progress.phases.behavior.status).toBe("blocked");
    expect(progress.phases.behavior.blockedReason).toContain("db:main");
    expect(progress.phases.intent.status).toBe("completed");
    expect(progress.phases.structure.status).toBe("completed");
    expect(progress.phases.reconcile.status).toBe("completed");
    expect(progress.phases.verify.status).toBe("completed");
  });

  it("3. --only structure runs structure + reconcile + verify only; intent stays pending", async () => {
    const root = await makeWorkspace();
    await runFrom(root, ["--only", "structure"], baseDeps());
    const progress = await readProgress(root);
    expect(progress.phases.intent.status).toBe("pending");
    expect(progress.phases.structure.status).toBe("completed");
    expect(progress.phases.behavior.status).toBe("pending");
    expect(progress.phases.reconcile.status).toBe("completed");
    expect(progress.phases.verify.status).toBe("completed");
  });

  it("4. resume: structure already completed within TTL is skipped (fake not called)", async () => {
    const root = await makeWorkspace();
    const p = withPhaseStatus(
      { runId: "prev", phases: emptyPhases(), updatedAt: new Date().toISOString() },
      "structure",
      "completed",
    );
    await writeProgress(progressPath(root), p);

    let called = false;
    const deps = baseDeps({
      analyzeStructureRepo: async (repoPath, hooks) => {
        called = true;
        await threeUnitFake(repoPath, hooks);
      },
    });
    await runFrom(root, [], deps);
    expect(called).toBe(false);
    const progress = await readProgress(root);
    expect(progress.phases.structure.status).toBe("completed");
  });

  it("5. TTL expired: a completed structure from 25h ago is re-run (fake IS called)", async () => {
    const root = await makeWorkspace();
    const oldAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const p: Progress = {
      runId: "prev",
      phases: {
        ...emptyPhases(),
        structure: { status: "completed", completedAt: oldAt, startedAt: oldAt, tasks: { total: 3, completed: 3 } },
      },
      updatedAt: oldAt,
    };
    await writeProgress(progressPath(root), p);

    let called = false;
    const deps = baseDeps({
      analyzeStructureRepo: async (repoPath, hooks) => {
        called = true;
        await threeUnitFake(repoPath, hooks);
      },
    });
    await runFrom(root, [], deps);
    expect(called).toBe(true);
    const progress = await readProgress(root);
    expect(progress.phases.structure.status).toBe("completed");
    expect(progress.phases.structure.tasks.completed).toBe(3);
  });

  it("6. structure throws: structure failed, behavior/reconcile/verify skipped (stay pending)", async () => {
    const root = await makeWorkspace();
    const deps = baseDeps({
      analyzeStructureRepo: async () => {
        throw new Error("boom");
      },
    });
    await runFrom(root, [], deps);
    const progress = await readProgress(root);
    expect(progress.phases.structure.status).toBe("failed");
    expect(progress.phases.behavior.status).toBe("pending");
    expect(progress.phases.reconcile.status).toBe("pending");
    expect(progress.phases.verify.status).toBe("pending");
  });

  it("7. intent.json missing: intent blocked, structure still runs", async () => {
    const root = await makeWorkspace({ intentJson: false });
    await runFrom(root, [], baseDeps());
    const progress = await readProgress(root);
    expect(progress.phases.intent.status).toBe("blocked");
    expect(progress.phases.intent.blockedReason).toContain("intent.json");
    expect(progress.phases.structure.status).toBe("completed");
  });

  it("8. flush: progress.json on disk shows behavior running before deps.runBehavior is invoked", async () => {
    const root = await makeWorkspace();
    let sawRunning = false;
    const deps = baseDeps({
      runBehavior: async (cwd) => {
        const onDisk = await readProgress(cwd);
        sawRunning = onDisk.phases.behavior.status === "running";
        return { ok: true, crawledPages: 1 };
      },
    });
    await runFrom(root, [], deps);
    expect(sawRunning).toBe(true);
  });

  it("9. unexpected positional arg inside a workspace is rejected", async () => {
    const root = await makeWorkspace();
    await expect(runFrom(root, ["some-repo"], baseDeps())).rejects.toThrow(/--only|--force|--no-viewer|--port/);
  });
});

function emptyPhases(): Progress["phases"] {
  const fresh = (): Progress["phases"]["intent"] => ({ status: "pending", tasks: { total: 0, completed: 0 } });
  return {
    intent: fresh(),
    structure: fresh(),
    behavior: fresh(),
    reconcile: fresh(),
    verify: fresh(),
  };
}
