// packages/viewer/src/dashboard-model.test.ts
//
// buildDashboardModel() reads progress.json + checks for the presence of every
// pipeline artifact, then derives per-menu guidance ("why is this menu empty").
// buildGuidance is pure (no I/O) so the menu-mapping logic is tested directly;
// buildDashboardModel is tested end-to-end against a temp workspace, mirroring
// view-model.test.ts's fixture style.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyProgress, withPhaseStatus } from "@crawl-kit/contract";
import { buildDashboardModel, buildGuidance, type DashboardArtifacts } from "./dashboard-model.js";

const allMissing: DashboardArtifacts = {
  intentNodes: false,
  intentAggregates: false,
  structureRdra: false,
  unified: false,
  behaviorNodes: false,
  transactions: false,
  sitemap: false,
  mapping: false,
};

describe("buildGuidance (pure)", () => {
  it("flags every menu as not-ok with a reason when nothing has run", () => {
    const progress = emptyProgress("run-1", "2026-01-01T00:00:00.000Z");
    const guidance = buildGuidance(allMissing, progress);

    expect(guidance.map((g) => g.menu)).toEqual([
      "intent",
      "structure",
      "behavior-traffic",
      "behavior-sitemap",
      "observability",
    ]);
    for (const g of guidance) {
      expect(g.ok).toBe(false);
      expect(g.reason).toBeTruthy();
      expect(g.command).toBeTruthy();
    }
  });

  it("marks intent ok once intent.nodes.json exists, with no reason", () => {
    const progress = emptyProgress("run-1", "2026-01-01T00:00:00.000Z");
    const guidance = buildGuidance({ ...allMissing, intentNodes: true }, progress);
    const intent = guidance.find((g) => g.menu === "intent")!;
    expect(intent.ok).toBe(true);
    expect(intent.reason).toBeUndefined();
    expect(intent.command).toBe("crawl-kit run --only intent");
  });

  it("folds blockedReason into the reason when the phase is blocked", () => {
    let progress = emptyProgress("run-1", "2026-01-01T00:00:00.000Z");
    progress = withPhaseStatus(progress, "intent", "blocked", { reason: "no glossary configured" });
    const guidance = buildGuidance(allMissing, progress);
    const intent = guidance.find((g) => g.menu === "intent")!;
    expect(intent.reason).toContain("no glossary configured");
  });

  it("structure menu is ok when EITHER structure.rdra.json or unified.json exists", () => {
    const progress = emptyProgress("run-1");
    expect(buildGuidance({ ...allMissing, structureRdra: true }, progress).find((g) => g.menu === "structure")!.ok).toBe(true);
    expect(buildGuidance({ ...allMissing, unified: true }, progress).find((g) => g.menu === "structure")!.ok).toBe(true);
    expect(buildGuidance(allMissing, progress).find((g) => g.menu === "structure")!.ok).toBe(false);
  });

  it("behavior-traffic requires BOTH transactions and a structure route source", () => {
    const progress = emptyProgress("run-1");
    expect(
      buildGuidance({ ...allMissing, transactions: true }, progress).find((g) => g.menu === "behavior-traffic")!.ok,
    ).toBe(false);
    expect(
      buildGuidance({ ...allMissing, transactions: true, structureRdra: true }, progress).find(
        (g) => g.menu === "behavior-traffic",
      )!.ok,
    ).toBe(true);
  });

  it("behavior-sitemap only requires the sitemap artifact", () => {
    const progress = emptyProgress("run-1");
    expect(buildGuidance({ ...allMissing, sitemap: true }, progress).find((g) => g.menu === "behavior-sitemap")!.ok).toBe(
      true,
    );
  });

  it("observability requires unified + intent + behavior node artifacts", () => {
    const progress = emptyProgress("run-1");
    expect(
      buildGuidance(
        { ...allMissing, unified: true, intentNodes: true, behaviorNodes: true },
        progress,
      ).find((g) => g.menu === "observability")!.ok,
    ).toBe(true);
    expect(
      buildGuidance({ ...allMissing, unified: true, intentNodes: true }, progress).find(
        (g) => g.menu === "observability",
      )!.ok,
    ).toBe(false);
  });

  it("observability's command is the valid `crawl-kit run` (reconcile has no --only entry)", () => {
    const progress = emptyProgress("run-1");
    const observability = buildGuidance(allMissing, progress).find((g) => g.menu === "observability")!;
    expect(observability.command).toBe("crawl-kit run");
  });
});

interface Workspace {
  root: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "ck-viewer-dash-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
  await mkdir(join(root, "data"), { recursive: true });
  return { root };
}

const prevCwd = process.cwd();
afterEach(() => {
  process.chdir(prevCwd);
});

describe("buildDashboardModel (I/O)", () => {
  it("reports empty progress + all-false artifacts + full guidance when nothing has run", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    const model = await buildDashboardModel();
    expect(model.progress.phases.intent.status).toBe("pending");
    expect(model.artifacts).toEqual(allMissing);
    expect(model.guidance).toHaveLength(5);
    expect(model.guidance.every((g) => !g.ok)).toBe(true);
  });

  it("reads progress.json and detects present artifacts", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    await writeFile(
      join(root, ".crawl-kit", "progress.json"),
      JSON.stringify({
        ...emptyProgress("run-1", "2026-01-01T00:00:00.000Z"),
      }),
      "utf8",
    );
    await writeFile(join(root, "data", "intent.nodes.json"), "[]", "utf8");
    await writeFile(join(root, "data", "unified.json"), JSON.stringify({ version: 1, generatedAt: "x", concepts: [] }), "utf8");

    const model = await buildDashboardModel();
    expect(model.progress.runId).toBe("run-1");
    expect(model.artifacts.intentNodes).toBe(true);
    expect(model.artifacts.unified).toBe(true);
    expect(model.artifacts.structureRdra).toBe(false);
    const structure = model.guidance.find((g) => g.menu === "structure")!;
    expect(structure.ok).toBe(true);
  });
});
