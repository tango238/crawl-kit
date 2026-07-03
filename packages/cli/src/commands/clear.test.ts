import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearPhase, cmdClear } from "./clear.js";
import {
  emptyProgress,
  readProgressOrEmpty,
  withPhaseStatus,
  writeProgress,
  progressPath,
} from "@crawl-kit/contract";
import { acquisitionPath, readStore, writeStore } from "@crawl-kit/freshness";

async function makeWorkspaceWithData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ck-clear-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
  await mkdir(join(root, "data"), { recursive: true });
  for (const f of [
    "intent.nodes.json",
    "intent.aggregates.json",
    "structure.nodes.json",
    "structure.rdra.json",
    "structure.er.mmd",
    "structure.usecases.mmd",
    "structure.routes.partial.json",
    "structure.corrections.json",
    "behavior.nodes.json",
    "behavior.transactions.jsonl",
    "unified.json",
    "verification.findings.json",
    "boundary.findings.json",
    "mapping.aggregate-entity.json",
    "registry.json",
    "decisions.json",
  ]) {
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

  it("intent phase clears intent.nodes.json only and resets intent's ledger entry", async () => {
    const root = await makeWorkspaceWithData();
    const p = withPhaseStatus(emptyProgress("r"), "intent", "completed");
    await writeProgress(progressPath(root), p);
    const removed = await clearPhase(root, "intent");
    expect(existsSync(join(root, "data", "intent.nodes.json"))).toBe(false);
    expect(existsSync(join(root, "data", "intent.aggregates.json"))).toBe(false);
    expect(existsSync(join(root, "data", "structure.nodes.json"))).toBe(true);
    expect(removed.some((r) => r.includes("intent.nodes.json"))).toBe(true);
    expect(removed.some((r) => r.includes("intent.aggregates.json"))).toBe(true);
    const after = await readProgressOrEmpty(progressPath(root), "x");
    expect(after.phases.intent.status).toBe("pending");
  });

  it("behavior phase clears behavior artifacts, resets acquisition.behavior, keeps structure", async () => {
    const root = await makeWorkspaceWithData();
    await writeStore(acquisitionPath(root), {
      ttlSeconds: 123,
      structure: { "src/": { lastAcquiredAt: "t", files: {} } },
      behavior: { "/home": { lastCrawledAt: "t", viewFiles: {} } },
    });
    await clearPhase(root, "behavior");
    expect(existsSync(join(root, "data", "behavior.nodes.json"))).toBe(false);
    expect(existsSync(join(root, "data", "behavior.transactions.jsonl"))).toBe(false);
    expect(existsSync(join(root, "data", "structure.nodes.json"))).toBe(true);
    const store = await readStore(acquisitionPath(root));
    expect(store.behavior).toEqual({});
    expect(store.structure).toEqual({ "src/": { lastAcquiredAt: "t", files: {} } }); // untouched
    expect(store.ttlSeconds).toBe(123); // preserved
  });

  it("structure phase keeps structure.corrections.json but removes other structure.* artifacts and resets acquisition.structure", async () => {
    const root = await makeWorkspaceWithData();
    await writeStore(acquisitionPath(root), {
      ttlSeconds: 99,
      structure: { "src/": { lastAcquiredAt: "t", files: {} } },
      behavior: { "/home": { lastCrawledAt: "t", viewFiles: {} } },
    });
    await clearPhase(root, "structure");
    expect(existsSync(join(root, "data", "structure.nodes.json"))).toBe(false);
    expect(existsSync(join(root, "data", "structure.rdra.json"))).toBe(false);
    expect(existsSync(join(root, "data", "structure.er.mmd"))).toBe(false);
    expect(existsSync(join(root, "data", "structure.usecases.mmd"))).toBe(false);
    expect(existsSync(join(root, "data", "structure.routes.partial.json"))).toBe(false);
    expect(existsSync(join(root, "data", "structure.corrections.json"))).toBe(true); // kept — human asset
    const store = await readStore(acquisitionPath(root));
    expect(store.structure).toEqual({});
    expect(store.behavior).toEqual({ "/home": { lastCrawledAt: "t", viewFiles: {} } }); // untouched
  });

  it("behavior phase also removes .e2e/runs, .e2e/reports, .e2e/findings, and the edges/sitemap data files, but keeps baseline/known-findings/feedback", async () => {
    const root = await makeWorkspaceWithData();
    for (const dir of ["runs", "reports", "findings", "baseline", "known-findings", "feedback"]) {
      await mkdir(join(root, ".e2e", dir), { recursive: true });
      await writeFile(join(root, ".e2e", dir, "marker.txt"), "x", "utf8");
    }
    await writeFile(join(root, "data", "behavior.edges.json"), "{}", "utf8");
    await writeFile(join(root, "data", "behavior.sitemap.json"), "{}", "utf8");

    const removed = await clearPhase(root, "behavior");

    expect(existsSync(join(root, ".e2e", "runs"))).toBe(false);
    expect(existsSync(join(root, ".e2e", "reports"))).toBe(false);
    expect(existsSync(join(root, ".e2e", "findings"))).toBe(false);
    expect(existsSync(join(root, "data", "behavior.edges.json"))).toBe(false);
    expect(existsSync(join(root, "data", "behavior.sitemap.json"))).toBe(false);
    // kept — not part of the behavior-clear deletion set
    expect(existsSync(join(root, ".e2e", "baseline"))).toBe(true);
    expect(existsSync(join(root, ".e2e", "known-findings"))).toBe(true);
    expect(existsSync(join(root, ".e2e", "feedback"))).toBe(true);
    expect(removed.some((r) => r.includes(join(".e2e", "runs")))).toBe(true);
    expect(removed.some((r) => r.includes(join(".e2e", "reports")))).toBe(true);
    expect(removed.some((r) => r.includes(join(".e2e", "findings")))).toBe(true);
  });

  it("structure phase also deletes each repo's own .crawl-kit-cache", async () => {
    const root = await makeWorkspaceWithData();
    await writeFile(
      join(root, ".crawl-kit", "workspace.yaml"),
      "repositories:\n  - { name: be, label: BE, url: 'https://example.com/be.git', role: backend, audience: user, path: be }\n",
      "utf8",
    );
    await mkdir(join(root, "be", ".crawl-kit-cache"), { recursive: true });
    await clearPhase(root, "structure");
    expect(existsSync(join(root, "be", ".crawl-kit-cache"))).toBe(false);
  });

  it("full clear resets every phase via emptyProgress (fresh runId)", async () => {
    const root = await makeWorkspaceWithData();
    const p = withPhaseStatus(emptyProgress("r"), "behavior", "blocked", { reason: "no db" });
    await writeProgress(progressPath(root), p);
    await clearPhase(root, undefined);
    const after = await readProgressOrEmpty(progressPath(root), "x");
    expect(after.phases.behavior.status).toBe("pending");
    expect(after.phases.behavior.blockedReason).toBeUndefined();
    expect(after.runId).not.toBe("r");
  });

  it("full clear (no --all) keeps registry.json, decisions.json, and structure.corrections.json", async () => {
    const root = await makeWorkspaceWithData();
    await clearPhase(root, undefined);
    expect(existsSync(join(root, "data", "registry.json"))).toBe(true);
    expect(existsSync(join(root, "data", "decisions.json"))).toBe(true);
    expect(existsSync(join(root, "data", "structure.corrections.json"))).toBe(true);
    expect(existsSync(join(root, "data", "unified.json"))).toBe(false);
    expect(existsSync(join(root, "data", "verification.findings.json"))).toBe(false);
    expect(existsSync(join(root, "data", "boundary.findings.json"))).toBe(false);
    expect(existsSync(join(root, "data", "mapping.aggregate-entity.json"))).toBe(false);
  });

  it("--all also removes decisions.json", async () => {
    const root = await makeWorkspaceWithData();
    await clearPhase(root, undefined, { all: true });
    expect(existsSync(join(root, "data", "decisions.json"))).toBe(false);
  });

  it("is idempotent — clearing an already-empty workspace does not throw", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-clear-empty-"));
    await mkdir(join(root, ".crawl-kit"), { recursive: true });
    await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
    await expect(clearPhase(root, "structure")).resolves.toBeDefined();
    await expect(clearPhase(root, undefined, { all: true })).resolves.toBeDefined();
  });
});

describe("cmdClear", () => {
  it("throws a usage error when run outside a workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ck-clear-nowk-"));
    await expect(cmdClearFrom(outside, ["--phase", "structure"])).rejects.toThrow();
  });

  it("clears the requested phase when run inside a workspace", async () => {
    const root = await makeWorkspaceWithData();
    await cmdClearFrom(root, ["--phase", "intent"]);
    expect(existsSync(join(root, "data", "intent.nodes.json"))).toBe(false);
  });

  it("rejects a bare trailing --phase with no value instead of silently doing a full clear", async () => {
    const root = await makeWorkspaceWithData();
    await expect(cmdClearFrom(root, ["--phase"])).rejects.toThrow();
    // and nothing was cleared — full-clear side effects did NOT happen
    expect(existsSync(join(root, "data", "unified.json"))).toBe(true);
  });
});

async function cmdClearFrom(cwd: string, args: string[]): Promise<void> {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    await cmdClear(args);
  } finally {
    process.chdir(prev);
  }
}
