// packages/structure/src/analyze/scan.ts
//
// The fs bridge for the deterministic diff-axis extractor: walk a repo, read the
// source files, and run the pure extractors in events.ts over them. Kept apart
// from events.ts so the pattern logic stays fs-free and unit-testable.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { extractEvents, extractStateTransitions, type SourceFile } from "./events.js";
import type { StructureEvent, StructureStateTransition } from "../model.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", "vendor",
  "__tests__", "__mocks__", "fixtures", "__fixtures__",
]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".py", ".rb", ".java", ".kt", ".cs", ".go"]);
/** test/spec files describe behaviour under test, not the as-built product. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;

/** Read source files under repoPath (skipping deps/build dirs), bounded for safety. */
export function readSourceFiles(repoPath: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // unreadable dir — skip rather than crash the analysis
    }
    for (const name of names) {
      if (files.length >= MAX_FILES) return;
      const full = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue; // broken symlink etc.
      }
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(full);
        continue;
      }
      const dot = name.lastIndexOf(".");
      if (dot < 0 || !EXTS.has(name.slice(dot)) || stat.size > MAX_FILE_BYTES) continue;
      if (TEST_FILE.test(name)) continue;
      try {
        files.push({ path: relative(repoPath, full), content: readFileSync(full, "utf8") });
      } catch {
        // unreadable file — skip
      }
    }
  };

  walk(repoPath);
  return files;
}

export interface DiffAxis {
  events: StructureEvent[];
  stateTransitions: StructureStateTransition[];
}

/** Walk repoPath and extract the structure-side events + state transitions. */
export function extractDiffAxis(repoPath: string): DiffAxis {
  const files = readSourceFiles(repoPath);
  return {
    events: extractEvents(files),
    stateTransitions: extractStateTransitions(files),
  };
}
