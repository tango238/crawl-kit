// packages/cli/src/commands/run-phases.test.ts
//
// Focused unit tests for phase bodies that don't need the full cmdRunWorkspace
// harness — currently just intentPhase's missing-vs-corrupt intent.json distinction.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_FILES, dataPath, emptyProgress, type Progress } from "@crawl-kit/contract";
import type { WorkspaceConfig } from "@crawl-kit/behavior";
import type { Glossary } from "@crawl-kit/intent";
import { behaviorPhase, intentPhase, type RunContext, type RunDeps } from "./run-phases.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ck-run-phases-"));
}

function makeCtx(
  root: string,
  deps: Partial<RunDeps> = {},
  config: Partial<WorkspaceConfig> = {},
): { ctx: RunContext; progress: () => Progress } {
  let current: Progress = emptyProgress("test");
  const ctx: RunContext = {
    root,
    runId: "test",
    // config is only read by behaviorPhase's crud gate — cast a minimal stand-in.
    config: config as RunContext["config"],
    deps: deps as RunContext["deps"],
    now: () => new Date(),
    commit: (updater) => {
      current = updater(current);
    },
  };
  return { ctx, progress: () => current };
}

/** Minimal workspace config for behaviorPhase — only the fields it reads. */
function behaviorConfig(over: Partial<WorkspaceConfig> = {}): Partial<WorkspaceConfig> {
  return {
    databases: [{ name: "db", type: "postgres", host: "h", port: 5432, database: "d", user: "u", passwordEnv: "PW" }],
    launch: { seed: { command: "seed" } },
    targets: [{ name: "app", baseUrl: "http://localhost:3000", auth: { strategy: "form" } }],
    ...over,
  } as unknown as Partial<WorkspaceConfig>;
}

const SAMPLE_GLOSSARY: Glossary = {
  concepts: [{ name: "Order", kind: "aggregate-root", attributes: ["orderId"] }],
  events: [{ name: "OrderPlaced", aggregate: "Order" }],
};

describe("intentPhase", () => {
  it("missing intent.json, no draftIntent dep: blocked with the combined guidance message", async () => {
    const root = await makeRoot();
    const { ctx } = makeCtx(root);
    const outcome = await intentPhase(ctx);
    expect(outcome).toEqual({
      status: "blocked",
      reason:
        "docs/domain/intent.json なし、LLM プロバイダも未設定 — /ddd（distill-ddd）で作成するか ANTHROPIC_API_KEY / USE_CLAUDE_CODE を設定してください",
    });
  });

  it("missing intent.json, draftIntent unavailable (returns null): blocked, reason mentions LLM プロバイダ", async () => {
    const root = await makeRoot();
    const { ctx, progress } = makeCtx(root, { draftIntent: async () => null });
    const outcome = await intentPhase(ctx);
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.reason).toContain("LLM プロバイダ");
    }
    expect(progress().phases.intent.tasks).toEqual({ total: 2, completed: 0 });
  });

  it("missing intent.json, draftIntent throws: blocked with the failure reason, not the no-provider message", async () => {
    const root = await makeRoot();
    const { ctx } = makeCtx(root, {
      draftIntent: async () => {
        throw new Error("boom");
      },
    });
    const outcome = await intentPhase(ctx);
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.reason).toContain("intent 自動ドラフトに失敗");
      expect(outcome.reason).toContain("boom");
      expect(outcome.reason).not.toContain("プロバイダも未設定");
    }
  });

  it("missing intent.json, draftIntent succeeds: writes intent.json + nodes + aggregates, tasks 2/2", async () => {
    const root = await makeRoot();
    const { ctx, progress } = makeCtx(root, { draftIntent: async () => SAMPLE_GLOSSARY });
    const outcome = await intentPhase(ctx);
    expect(outcome).toEqual({ status: "completed" });

    const written = JSON.parse(await readFile(join(root, "docs", "domain", "intent.json"), "utf8"));
    expect(written).toEqual(SAMPLE_GLOSSARY);

    const nodes = JSON.parse(await readFile(dataPath(DATA_FILES.intentNodes, root), "utf8"));
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);

    const aggregates = JSON.parse(await readFile(dataPath(DATA_FILES.intentAggregates, root), "utf8"));
    expect(aggregates.aggregates).toHaveLength(1);
    expect(aggregates.aggregates[0].name).toBe("Order");

    expect(progress().phases.intent.tasks).toEqual({ total: 2, completed: 2 });
  });

  it("corrupt intent.json (invalid JSON): blocked with a parse-error message, distinct from missing", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "docs", "domain"), { recursive: true });
    await writeFile(join(root, "docs", "domain", "intent.json"), "{ not valid json", "utf8");

    const { ctx } = makeCtx(root);
    const outcome = await intentPhase(ctx);
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.reason).toContain("intent.json の読み込みに失敗");
      expect(outcome.reason).not.toContain("なし");
    }
  });

  it("valid intent.json: completed, and writes intent.aggregates.json too", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "docs", "domain"), { recursive: true });
    await writeFile(join(root, "docs", "domain", "intent.json"), JSON.stringify(SAMPLE_GLOSSARY), "utf8");

    const { ctx, progress } = makeCtx(root);
    const outcome = await intentPhase(ctx);
    expect(outcome).toEqual({ status: "completed" });

    const aggregates = JSON.parse(await readFile(dataPath(DATA_FILES.intentAggregates, root), "utf8"));
    expect(aggregates.aggregates).toHaveLength(1);
    expect(aggregates.aggregates[0].name).toBe("Order");

    expect(progress().phases.intent.tasks).toEqual({ total: 1, completed: 1 });
  });
});

describe("behaviorPhase crud gate", () => {
  it("gate PASSES (db + launch.seed + form-auth target): runBehavior called with crud:true", async () => {
    const root = await makeRoot();
    let seen: { crud: boolean; crudSkipReason?: string } | undefined;
    const { ctx } = makeCtx(
      root,
      { runBehavior: async (_cwd, opts) => ((seen = opts), { ok: true, crawledPages: 1 }) },
      behaviorConfig(),
    );
    const outcome = await behaviorPhase(ctx);
    expect(outcome).toEqual({ status: "completed" });
    expect(seen?.crud).toBe(true);
  });

  it("gate FAILS (no databases): runBehavior called with crud:false and a skip reason", async () => {
    const root = await makeRoot();
    let seen: { crud: boolean; crudSkipReason?: string } | undefined;
    const { ctx } = makeCtx(
      root,
      { runBehavior: async (_cwd, opts) => ((seen = opts), { ok: true, crawledPages: 1 }) },
      behaviorConfig({ databases: [] as unknown as WorkspaceConfig["databases"] }),
    );
    const outcome = await behaviorPhase(ctx);
    expect(outcome).toEqual({ status: "completed" });
    expect(seen?.crud).toBe(false);
    expect(seen?.crudSkipReason).toBeTruthy();
  });
});
