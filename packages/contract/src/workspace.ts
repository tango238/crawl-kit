// packages/contract/src/workspace.ts
//
// Workspace discovery. A "workspace" is a root directory holding cloned repos,
// marked by `.crawl-kit/workspace.yaml`. It is the single unit of work: config,
// progress ledger, and all data/ artifacts live under it. Tools resolve paths
// through here so every package agrees on "where things are".

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findRepoRoot } from "./paths.js";

export const CRAWL_KIT_DIR = ".crawl-kit";

export const WORKSPACE_FILES = {
  config: "workspace.yaml",
  progress: "progress.json",
} as const;

/** Walk upward looking for `.crawl-kit/workspace.yaml`. Null when not inside a workspace. */
export function findWorkspaceRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CRAWL_KIT_DIR, WORKSPACE_FILES.config))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Workspace root when inside one, else the legacy repo-root fallback. */
export function resolveRoot(start: string = process.cwd()): string {
  return findWorkspaceRoot(start) ?? findRepoRoot(start);
}

/** `<root>/.crawl-kit/<segments...>` */
export function crawlKitPath(root: string, ...segments: string[]): string {
  return join(root, CRAWL_KIT_DIR, ...segments);
}

export function workspaceConfigPath(root: string): string {
  return crawlKitPath(root, WORKSPACE_FILES.config);
}

export function progressPath(root: string): string {
  return crawlKitPath(root, WORKSPACE_FILES.progress);
}

export function repoConfigPath(root: string, name: string): string {
  return crawlKitPath(root, "repos", `${name}.yaml`);
}
