// packages/contract/src/paths.ts
//
// The data/ directory lives at the repo root, but pnpm runs each package's
// scripts with cwd set to that PACKAGE, not the root. So every tool needs the
// same answer to "where is data/?". One implementation, here, on the spine.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Where does `data/` live? In the crawl-kit monorepo that's the pnpm-workspace
 * root. When crawl-kit runs as an installed CLI (`npx crawl-kit`) inside someone
 * else's project, there's no workspace marker — so fall back to the nearest
 * package.json (their project root), and finally to the start dir.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  let pkgFallback: string | null = null;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (pkgFallback === null && existsSync(join(dir, "package.json"))) pkgFallback = dir;
    const parent = dirname(dir);
    if (parent === dir) return pkgFallback ?? resolve(start);
    dir = parent;
  }
}

/** Same walk as workspace.ts#findWorkspaceRoot — duplicated here (3 lines) to keep
 *  paths.ts dependency-free and avoid a paths↔workspace import cycle. */
function workspaceRootOrNull(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".crawl-kit", "workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Absolute path to a file in the workspace (preferred) or legacy repo data/ directory. */
export function dataPath(name: string, start?: string): string {
  const base = workspaceRootOrNull(start ?? process.cwd()) ?? findRepoRoot(start);
  return join(base, "data", name);
}

/** The canonical data file names every tool agrees on. */
export const DATA_FILES = {
  intentNodes: "intent.nodes.json",
  structureNodes: "structure.nodes.json",
  structureRoutesPartial: "structure.routes.partial.json",
  behaviorNodes: "behavior.nodes.json",
  registry: "registry.json",
  unified: "unified.json",
  verificationFindings: "verification.findings.json",
  boundaryFindings: "boundary.findings.json",
  acquisition: "acquisition.json",
  behaviorTransactions: "behavior.transactions.jsonl",
  intentAggregates: "intent.aggregates.json",
  aggregateEntityMapping: "mapping.aggregate-entity.json",
  behaviorEdges: "behavior.edges.json",
  behaviorSitemap: "behavior.sitemap.json",
} as const;
