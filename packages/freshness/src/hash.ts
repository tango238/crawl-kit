// packages/freshness/src/hash.ts
//
// The cheap, local change signal: walk a repo and content-hash every watched file,
// grouped by directory. Hashing is IO-only (no LLM), so we can afford to do it every
// run and use it to cull the expensive LLM acquisition.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { FileHashes } from "./model.js";

const DEFAULT_IGNORE = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next", ".cache",
  "coverage", "vendor", "__pycache__", ".venv", "venv", "data",
]);
const DEFAULT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
  ".py", ".rb", ".java", ".kt", ".cs", ".go", ".php",
  ".vue", ".svelte", ".erb", ".blade.php", ".html",
  ".sql", ".prisma",
]);
const MAX_FILE_BYTES = 1024 * 1024;

export interface ScanOptions {
  ignore?: Set<string>;
  exts?: Set<string>;
  maxFileBytes?: number;
}

/** sha1 (first 16 hex chars) of a string — short but collision-safe enough for change detection. */
export function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

function matchesExt(name: string, exts: Set<string>): boolean {
  for (const e of exts) if (name.endsWith(e)) return true;
  return false;
}

/**
 * Walk `root` and return dir(relative) → { file(relative) → hash }. Directories with
 * no watched files are omitted. Paths are POSIX-relative to `root`.
 */
export function scanByDir(root: string, opts: ScanOptions = {}): Map<string, FileHashes> {
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const exts = opts.exts ?? DEFAULT_EXTS;
  const maxBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const out = new Map<string, FileHashes>();

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!ignore.has(name) && !name.startsWith(".")) walk(full);
        continue;
      }
      if (!matchesExt(name, exts) || stat.size > maxBytes) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const relPath = relative(root, full).split("\\").join("/");
      const relDir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".";
      const bucket = out.get(relDir) ?? {};
      bucket[relPath] = hashContent(content);
      out.set(relDir, bucket);
    }
  };

  walk(root);
  return out;
}

/** Flatten a dir→files map into a single path→hash map (e.g. to back a page's viewFiles). */
export function flatten(byDir: Map<string, FileHashes>): FileHashes {
  const all: FileHashes = {};
  for (const files of byDir.values()) Object.assign(all, files);
  return all;
}
