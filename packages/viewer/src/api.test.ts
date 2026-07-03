// packages/viewer/src/api.test.ts
//
// apiRoutes is the single source of truth both HTTP servers (cli's startViewer +
// viewer's dev server) wire up — this test locks its shape (path → async body
// producer) and end-to-end behavior against a temp workspace, mirroring
// dashboard-model.test.ts's fixture style. "/transactions.jsonl" is deliberately
// NOT in apiRoutes (it's raw ndjson, not JSON) — readTransactionsRaw covers it.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiRoutes, readTransactionsRaw } from "./api.js";

interface Workspace {
  root: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "ck-viewer-api-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
  await mkdir(join(root, "data"), { recursive: true });
  return { root };
}

const prevCwd = process.cwd();
afterEach(() => {
  process.chdir(prevCwd);
});

describe("apiRoutes", () => {
  it("maps every documented path to an async producer", () => {
    expect(Object.keys(apiRoutes).sort()).toEqual(
      ["/api/dashboard.json", "/api/intent.json", "/api/sitemap.json", "/api/traffic.json", "/diff.json", "/view-model.json"].sort(),
    );
    for (const fn of Object.values(apiRoutes)) {
      expect(typeof fn).toBe("function");
    }
  });

  it("does not include /transactions.jsonl (raw passthrough, not JSON)", () => {
    expect(apiRoutes["/transactions.jsonl"]).toBeUndefined();
  });

  it("each route resolves without throwing on an empty temp workspace", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    for (const [path, fn] of Object.entries(apiRoutes)) {
      await expect(fn(), path).resolves.toBeDefined();
    }
  });

  it("/api/dashboard.json returns a DashboardModel shape", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    const model = (await apiRoutes["/api/dashboard.json"]!()) as { progress: unknown; artifacts: unknown; guidance: unknown };
    expect(model.progress).toBeDefined();
    expect(model.artifacts).toBeDefined();
    expect(model.guidance).toBeDefined();
  });

  it("/api/sitemap.json resolves to the null literal when no sitemap exists yet", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    const sitemap = await apiRoutes["/api/sitemap.json"]!();
    expect(sitemap).toBeNull();
  });
});

describe("readTransactionsRaw", () => {
  it("returns an empty string when data/behavior.transactions.jsonl is absent", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    expect(await readTransactionsRaw()).toBe("");
  });

  it("returns the raw file contents (ndjson, not parsed) when present", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);
    const line = `${JSON.stringify({ method: "GET", path: "/x" })}\n`;
    await writeFile(join(root, "data", "behavior.transactions.jsonl"), line, "utf8");

    expect(await readTransactionsRaw()).toBe(line);
  });
});
