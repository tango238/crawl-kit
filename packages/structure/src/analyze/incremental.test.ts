import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyFragment, type StructureFragment } from "./fragments.js";
import { analyzeRepoIncremental } from "./incremental.js";
import type { StructureExtract } from "../model.js";
import type { Unit } from "./units.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ck-inc-"));

const units: Unit[] = [
  { id: "laravel:routes/web", hash: "h1", kind: "routes", framework: "laravel", files: ["routes/web.php"] },
  { id: "laravel:models", hash: "h1", kind: "models", framework: "laravel", files: ["app/Models/Order.php"] },
];

const parse = async (u: Unit, pass: number): Promise<StructureFragment> => {
  const base = emptyFragment(u.id, u.hash, pass);
  if (u.kind === "routes") {
    return { ...base, routes: [{ method: "GET", path: "/orders", controller: "OrderController", action: "index", middleware: [], prefix: "" }] };
  }
  if (u.kind === "models") {
    return { ...base, models: [{ className: "Order", tableName: "orders", fillable: ["id", "total"], relationships: [], casts: {}, scopes: [] }] };
  }
  return base;
};

describe("analyzeRepoIncremental", () => {
  it("projects merged units into a StructureExtract (routes + entities)", async () => {
    const res = await analyzeRepoIncremental("/repo", {
      llm: null, cacheDir: tmp(), enumerate: () => units, parse, passes: [1, 2], skipDiffAxis: true,
    });
    expect(res.extract.routes.some((r) => r.path === "/orders")).toBe(true);
    // entities are derived from models (fallback path with llm=null)
    expect(res.extract.entities.some((e) => e.name === "orders")).toBe(true);
  });

  it("emits a routes-only partial after pass 1 (before detail passes)", async () => {
    const seen: Array<{ pass: number; routes: number; entities: number }> = [];
    await analyzeRepoIncremental("/repo", {
      llm: null, cacheDir: tmp(), enumerate: () => units, parse, passes: [1, 2], skipDiffAxis: true,
      onPass: (pass, extract: StructureExtract) => {
        seen.push({ pass, routes: extract.routes.length, entities: extract.entities.length });
      },
    });
    expect(seen.map((s) => s.pass)).toEqual([1, 2]);
    const pass1 = seen.find((s) => s.pass === 1)!;
    expect(pass1.routes).toBeGreaterThan(0);
  });

  it("exposes the pass-1 routes partial on the result", async () => {
    const res = await analyzeRepoIncremental("/repo", {
      llm: null, cacheDir: tmp(), enumerate: () => units, parse, passes: [1], skipDiffAxis: true,
    });
    expect(res.routesPartial.routes.some((r) => r.path === "/orders")).toBe(true);
  });

  it("re-parses nothing on a second run with an unchanged repo (diff)", async () => {
    const dir = tmp();
    const calls: string[] = [];
    const counting = async (u: Unit, pass: number): Promise<StructureFragment> => {
      calls.push(`${u.id}:${pass}`);
      return parse(u, pass);
    };
    const opts = { llm: null, cacheDir: dir, enumerate: () => units, parse: counting, passes: [1], skipDiffAxis: true };
    await analyzeRepoIncremental("/repo", opts);
    const first = calls.length;
    await analyzeRepoIncremental("/repo", opts);
    expect(calls.length).toBe(first); // served from the fragment cache
  });
});
