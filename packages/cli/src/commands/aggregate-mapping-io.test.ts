import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAggregateMapping } from "./aggregate-mapping-io.js";

const UNIFIED_FIXTURE = {
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  concepts: [
    {
      conceptId: "concept:order",
      canonicalName: "Order",
      state: "aligned",
      structure: [
        {
          nodeId: "structure:entity/Order",
          layer: "structure",
          localName: "Order",
          raw: { kind: "entity", attributes: [], dependsOn: [], crud: [] },
          source: { tool: "rdra-analyzer" },
        },
      ],
      decisions: [],
      divergences: [],
    },
  ],
};

const AGGREGATES_FIXTURE = {
  aggregates: [
    {
      conceptId: "concept:order",
      name: "Order",
      members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
    },
  ],
};

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ck-agg-mapping-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
  await mkdir(join(root, "data"), { recursive: true });
  return root;
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

describe("writeAggregateMapping", () => {
  it("derives and writes the mapping when both unified.json and intent.aggregates.json exist", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "data", "unified.json"), JSON.stringify(UNIFIED_FIXTURE), "utf8");
    await writeFile(join(root, "data", "intent.aggregates.json"), JSON.stringify(AGGREGATES_FIXTURE), "utf8");

    const result = await withCwd(root, () => writeAggregateMapping());

    expect(result).toEqual({ written: true, aggregates: 1, unassigned: 0 });
    const mappingPath = join(root, "data", "mapping.aggregate-entity.json");
    expect(existsSync(mappingPath)).toBe(true);
    const written = JSON.parse(await readFile(mappingPath, "utf8"));
    expect(written.aggregates).toHaveLength(1);
    expect(written.aggregates[0]).toMatchObject({ conceptId: "concept:order", name: "Order" });
    expect(written.aggregates[0].entities).toEqual([
      {
        nodeId: "structure:entity/Order",
        entity: "Order",
        confidence: 0.95,
        evidence: "reconciled to aggregate root",
      },
    ]);
  });

  it("silently skips (written: false) when unified.json is missing", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "data", "intent.aggregates.json"), JSON.stringify(AGGREGATES_FIXTURE), "utf8");

    const result = await withCwd(root, () => writeAggregateMapping());

    expect(result).toEqual({ written: false, aggregates: 0, unassigned: 0 });
    expect(existsSync(join(root, "data", "mapping.aggregate-entity.json"))).toBe(false);
  });

  it("silently skips (written: false) when intent.aggregates.json is missing", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "data", "unified.json"), JSON.stringify(UNIFIED_FIXTURE), "utf8");

    const result = await withCwd(root, () => writeAggregateMapping());

    expect(result).toEqual({ written: false, aggregates: 0, unassigned: 0 });
    expect(existsSync(join(root, "data", "mapping.aggregate-entity.json"))).toBe(false);
  });
});
