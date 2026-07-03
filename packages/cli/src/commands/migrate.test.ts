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

const LEGACY_YAML_TWO_REPOS = [
  "repositories:",
  '  - { name: be, label: BE, url: "https://example.com/be.git", role: backend, audience: user }',
  '  - { name: fe, label: FE, url: "https://example.com/fe.git", role: frontend, audience: user }',
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

  it("does NOT stamp path: '.' on any repo when the legacy config has multiple repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-mig4-"));
    await writeFile(join(root, "e2e.config.yaml"), LEGACY_YAML_TWO_REPOS, "utf8");
    const { converted } = await migrateLegacy(root);
    expect(converted).toBe(true);
    const text = await readFile(join(root, ".crawl-kit", "workspace.yaml"), "utf8");
    expect(text).not.toContain("path:");
  });

  it("throws (and writes nothing) when the converted config is not workspace-schema-valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-mig5-"));
    // repositories: [] fails WorkspaceConfigSchema's min(1) — an incompatible legacy config.
    await writeFile(join(root, "e2e.config.yaml"), "repositories: []\n", "utf8");
    await expect(migrateLegacy(root)).rejects.toThrow(/workspace\.yaml|互換性/);
    expect(existsSync(join(root, ".crawl-kit"))).toBe(false);
  });
});
