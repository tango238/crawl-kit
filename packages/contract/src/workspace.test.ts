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
