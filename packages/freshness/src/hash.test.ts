import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanByDir, hashContent, flatten } from "./hash.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ck-fresh-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;");
  writeFileSync(join(root, "src", "notes.md"), "ignored ext");
  writeFileSync(join(root, "node_modules", "dep.ts"), "ignored dir");
  return root;
}

describe("scanByDir", () => {
  it("hashes watched files grouped by directory, skipping ignored dirs and exts", () => {
    const root = fixture();
    const byDir = scanByDir(root);
    expect([...byDir.keys()]).toEqual(["src"]); // node_modules skipped
    const src = byDir.get("src")!;
    expect(Object.keys(src).sort()).toEqual(["src/a.ts", "src/b.ts"]); // .md skipped
    expect(src["src/a.ts"]).toBe(hashContent("export const a = 1;"));
  });

  it("flatten merges all dirs into one path→hash map", () => {
    const root = fixture();
    const all = flatten(scanByDir(root));
    expect(Object.keys(all).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
