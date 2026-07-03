// packages/viewer/src/view-model.test.ts
//
// buildViewModel() reads data/ relative to the workspace root. Previously it walked
// via findRepoRoot() (pnpm-workspace.yaml / nearest package.json only), so running
// crawl-kit inside a `.crawl-kit/workspace.yaml` workspace whose repo checkouts also
// have their own package.json could resolve the wrong data/ dir. This asserts it now
// finds the workspace-level data/ dir via the contract's workspace-aware resolveRoot().

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildViewModel } from "./view-model.js";

interface Workspace {
  root: string;
  repo: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "ck-viewer-ws-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");

  // a repo checkout with its OWN package.json — the old findRepoRoot() fallback would
  // stop here (nearest package.json) instead of walking up to the workspace root.
  const repo = join(root, "be");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "package.json"), "{}", "utf8");

  // the data the workspace-level `run` orchestrator would have written.
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    join(root, "data", "unified.json"),
    JSON.stringify({ generatedAt: "2026-01-01T00:00:00.000Z", concepts: [{ conceptId: "concept:route//x", canonicalName: "x", state: "matched" }] }),
    "utf8",
  );
  // structure.rdra.json is read via the `dataDir` local (join(<root>, "data")) — the
  // bug: that used to be computed with findRepoRoot(), which (from inside `repo`)
  // stops at `repo`'s own package.json instead of walking up to the workspace root.
  await writeFile(
    join(root, "data", "structure.rdra.json"),
    JSON.stringify({ entities: [{ name: "Order", attributes: ["id"] }], usecases: [] }),
    "utf8",
  );

  return { root, repo };
}

const prevCwd = process.cwd();
afterEach(() => {
  process.chdir(prevCwd);
});

describe("buildViewModel", () => {
  it("finds the workspace root's data/ dir even from inside a repo checkout with its own package.json", async () => {
    const { repo } = await makeWorkspace();
    process.chdir(repo);

    const model = await buildViewModel();
    expect(model.generated_at).toBe("2026-01-01T00:00:00.000Z");
    expect(model.reconcile).toHaveLength(1);
    expect(model.reconcile[0]!.name).toBe("x");
    expect(model.entities).toHaveLength(1);
    expect(model.entities[0]!.name).toBe("Order");
  });
});
