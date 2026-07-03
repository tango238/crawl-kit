import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyFragment,
  fragmentFile,
  readFragment,
  writeFragment,
  type StructureFragment,
} from "./fragments.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ck-frag-"));

const frag = (over: Partial<StructureFragment> = {}): StructureFragment => ({
  ...emptyFragment("laravel:routes/web", "abc123", 1),
  routes: [
    { method: "GET", path: "/users", controller: "UserController", action: "index", middleware: [], prefix: "" },
  ],
  ...over,
});

describe("fragments cache", () => {
  it("round-trips a fragment through write → read", () => {
    const dir = tmp();
    const f = frag();
    writeFragment(dir, f);
    const got = readFragment(dir, f.unitId, f.hash, f.pass);
    expect(got).toEqual(f);
  });

  it("returns null on a cache miss (never written)", () => {
    const dir = tmp();
    expect(readFragment(dir, "laravel:routes/web", "nope", 1)).toBeNull();
  });

  it("misses when the unit hash differs (content changed → stale)", () => {
    const dir = tmp();
    const f = frag({ hash: "hash-v1" });
    writeFragment(dir, f);
    expect(readFragment(dir, f.unitId, "hash-v2", f.pass)).toBeNull();
    expect(readFragment(dir, f.unitId, "hash-v1", f.pass)).toEqual(f);
  });

  it("misses when the pass differs", () => {
    const dir = tmp();
    const f = frag({ pass: 1 });
    writeFragment(dir, f);
    expect(readFragment(dir, f.unitId, f.hash, 2)).toBeNull();
  });

  it("returns null on corrupted json", () => {
    const dir = tmp();
    // write a valid fragment first (creates the fragments/ dir), then clobber the file.
    writeFragment(dir, frag({ unitId: "laravel:models", hash: "h", pass: 2 }));
    writeFileSync(fragmentFile(dir, "laravel:models", "h", 2), "{ not json");
    expect(readFragment(dir, "laravel:models", "h", 2)).toBeNull();
  });

  it("gives colliding-after-sanitize ids distinct files", () => {
    const a = fragmentFile("/c", "laravel:controllers/Admin", "h", 1);
    const b = fragmentFile("/c", "laravel:controllers:Admin", "h", 1);
    expect(a).not.toBe(b);
  });
});
