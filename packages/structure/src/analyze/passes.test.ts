import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyFragment, type StructureFragment } from "./fragments.js";
import { runPasses, type RunPassesDeps } from "./passes.js";
import type { Unit } from "./units.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ck-passes-"));

const unit = (id: string, hash: string): Unit => ({
  id, hash, kind: "routes", framework: "laravel", files: [`${id}.php`],
});

/** A fake parseUnit that records every call and returns a route named after the unit. */
function fakeParser() {
  const calls: Array<{ id: string; pass: number }> = [];
  const parse = async (u: Unit, pass: number): Promise<StructureFragment> => {
    calls.push({ id: u.id, pass });
    return {
      ...emptyFragment(u.id, u.hash, pass),
      routes: [{ method: "GET", path: `/${u.id}`, controller: "", action: "", middleware: [], prefix: "" }],
    };
  };
  return { calls, parse };
}

const baseDeps = (cacheDir: string, units: Unit[], parse: RunPassesDeps["parse"]): RunPassesDeps => ({
  llm: null,
  cacheDir,
  enumerate: () => units,
  parse,
});

describe("runPasses — fan-out + merge", () => {
  it("parses every unit and merges the fragments for the pass", async () => {
    const dir = tmp();
    const { calls, parse } = fakeParser();
    const units = [unit("a", "h1"), unit("b", "h1")];
    const res = await runPasses("/repo", { passes: [1] }, baseDeps(dir, units, parse));
    expect(calls).toHaveLength(2);
    expect(res.passes[0].merged.routes.map((r) => r.path).sort()).toEqual(["/a", "/b"]);
  });

  it("runs multiple passes in order, invoking onPass per pass", async () => {
    const dir = tmp();
    const { parse } = fakeParser();
    const seen: number[] = [];
    const units = [unit("a", "h1")];
    await runPasses("/repo", { passes: [1, 2] }, {
      ...baseDeps(dir, units, parse),
      onPass: (pass) => { seen.push(pass); },
    });
    expect(seen).toEqual([1, 2]);
  });
});

describe("runPasses — onUnit progress hook", () => {
  it("fires once per unit per pass with a 1-based completion index and pass total", async () => {
    const dir = tmp();
    const { parse } = fakeParser();
    const units = [unit("a", "h1"), unit("b", "h1")];
    const calls: Array<{ pass: number; unitId: string; index: number; total: number }> = [];
    await runPasses("/repo", { passes: [1, 2] }, {
      ...baseDeps(dir, units, parse),
      onUnit: (pass, unitId, index, total) => { calls.push({ pass, unitId, index, total }); },
    });
    expect(calls).toHaveLength(4); // 2 units × 2 passes
    expect(calls.filter((c) => c.pass === 1).map((c) => c.index).sort()).toEqual([1, 2]);
    expect(calls.filter((c) => c.pass === 2).map((c) => c.index).sort()).toEqual([1, 2]);
    expect(calls.every((c) => c.total === 2)).toBe(true);
    expect(calls.filter((c) => c.pass === 1).map((c) => c.unitId).sort()).toEqual(["a", "b"]);
  });

  it("fires onUnit on a cache hit too (not just fresh parses)", async () => {
    const dir = tmp();
    const { parse } = fakeParser();
    const units = [unit("a", "h1")];
    await runPasses("/repo", { passes: [1] }, baseDeps(dir, units, parse));
    const calls: Array<{ pass: number; unitId: string; index: number; total: number }> = [];
    await runPasses("/repo", { passes: [1] }, {
      ...baseDeps(dir, units, parse),
      onUnit: (pass, unitId, index, total) => { calls.push({ pass, unitId, index, total }); },
    });
    expect(calls).toEqual([{ pass: 1, unitId: "a", index: 1, total: 1 }]);
  });

  it("does nothing when onUnit is not provided", async () => {
    const dir = tmp();
    const { parse } = fakeParser();
    const units = [unit("a", "h1")];
    await expect(runPasses("/repo", { passes: [1] }, baseDeps(dir, units, parse))).resolves.toBeDefined();
  });
});

describe("runPasses — diff via fragment cache", () => {
  it("re-parses nothing on a second run with unchanged units", async () => {
    const dir = tmp();
    const { calls, parse } = fakeParser();
    const units = [unit("a", "h1"), unit("b", "h1")];
    await runPasses("/repo", { passes: [1] }, baseDeps(dir, units, parse));
    expect(calls).toHaveLength(2);
    const res2 = await runPasses("/repo", { passes: [1] }, baseDeps(dir, units, parse));
    expect(calls).toHaveLength(2); // no new calls — all served from cache
    expect(res2.passes[0].merged.routes).toHaveLength(2); // still complete
  });

  it("re-parses only the dirty unit when one unit's hash changes", async () => {
    const dir = tmp();
    const { calls, parse } = fakeParser();
    await runPasses("/repo", { passes: [1] }, baseDeps(dir, [unit("a", "h1"), unit("b", "h1")], parse));
    expect(calls).toHaveLength(2);
    // b's content changed → new hash; a unchanged
    await runPasses("/repo", { passes: [1] }, baseDeps(dir, [unit("a", "h1"), unit("b", "h2")], parse));
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({ id: "b", pass: 1 });
  });

  it("force re-parses everything, ignoring the cache", async () => {
    const dir = tmp();
    const { calls, parse } = fakeParser();
    const units = [unit("a", "h1")];
    await runPasses("/repo", { passes: [1] }, baseDeps(dir, units, parse));
    await runPasses("/repo", { passes: [1], force: true }, baseDeps(dir, units, parse));
    expect(calls).toHaveLength(2); // parsed again despite cache
  });
});
