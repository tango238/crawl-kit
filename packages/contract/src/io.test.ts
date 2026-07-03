import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Registry } from "./model.js";
import {
  emptyRegistry,
  readJsonFile,
  readJsonFileOr,
  readRegistry,
  readRegistryOrEmpty,
  writeJsonAtomic,
  writeRegistry,
} from "./io.js";
import { ValidationError } from "./validate.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "crawl-kit-io-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sound(): Registry {
  return {
    version: 1,
    concepts: {
      "concept:order": {
        conceptId: "concept:order",
        canonicalName: "Order",
        aliases: [],
        nodes: {},
        state: "aligned",
        decisions: [],
      },
    },
    adrs: {},
    relations: [],
  };
}

describe("registry io", () => {
  it("round-trips a valid registry through disk", async () => {
    const path = join(dir, "registry.json");
    await writeRegistry(path, sound());
    const back = await readRegistry(path);
    expect(back).toEqual(sound());
  });

  it("refuses to write an invalid registry (validation is a gate)", async () => {
    const path = join(dir, "registry.json");
    const bad = sound();
    bad.concepts["concept:order"]!.decisions = ["adr:missing"];
    await expect(writeRegistry(path, bad)).rejects.toBeInstanceOf(ValidationError);
    // nothing should have been written
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("readRegistryOrEmpty returns an empty registry when the file is absent", async () => {
    const back = await readRegistryOrEmpty(join(dir, "nope.json"));
    expect(back).toEqual(emptyRegistry());
  });

  it("throws a clear error on malformed JSON", async () => {
    const path = join(dir, "broken.json");
    await writeRegistry(path, sound());
    await import("node:fs/promises").then((fs) => fs.writeFile(path, "{ not json", "utf8"));
    await expect(readRegistry(path)).rejects.toThrowError(/not valid JSON/);
  });
});

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
