// packages/cli/src/commands/structure-merge.ts
//
// Pure helpers extracted from the workspace `run` orchestrator's `makeAnalyzeStructureRepo`
// closure (index.ts): merging per-repo StructureExtracts into one combined extract, and
// namespacing freshness scan keys per repo so two repos sharing a directory name (e.g.
// both having `src/`) don't collide in acquisition.structure. No I/O, no console — index.ts
// owns all side effects and just wires these in.

import { basename } from "node:path";
import type { StructureExtract } from "@crawl-kit/structure";
import type { FileHashes } from "@crawl-kit/freshness";

type WithRepo<T> = T & { repo: string };

function tag<T>(items: T[] | undefined, repo: string): WithRepo<T>[] {
  return (items ?? []).map((item) => ({ ...item, repo }));
}

/**
 * Merge every repo's latest StructureExtract into one combined extract.
 *
 * - 0 repos: an empty extract.
 * - 1 repo: identity — the repo's own extract, unmodified (no `repo` tag on any record,
 *   byte-identical to the legacy single-repo `runIncremental` output).
 * - 2+ repos: every record (routes/entities/usecases/entityOperations/events/
 *   stateTransitions) is tagged `repo: <basename of its abs path>`, and `crudOverrides`
 *   is shallow-merged across repos (later repo in iteration order wins on key collision).
 *
 * `perRepo` should map each repo's absolute path to its most recent extract.
 */
export function mergedExtract(perRepo: Map<string, StructureExtract>): StructureExtract {
  const entries = [...perRepo.entries()];
  if (entries.length === 0) return { routes: [], entities: [], usecases: [] };
  if (entries.length === 1) return entries[0]![1];

  const out: StructureExtract = {
    routes: [],
    entities: [],
    usecases: [],
    entityOperations: [],
    events: [],
    stateTransitions: [],
  };
  let crudOverrides: StructureExtract["crudOverrides"];
  for (const [repoPath, extract] of entries) {
    const repo = basename(repoPath);
    out.routes.push(...tag(extract.routes, repo));
    out.entities.push(...tag(extract.entities, repo));
    out.usecases.push(...tag(extract.usecases, repo));
    out.entityOperations!.push(...tag(extract.entityOperations, repo));
    out.events!.push(...tag(extract.events, repo));
    out.stateTransitions!.push(...tag(extract.stateTransitions, repo));
    if (extract.crudOverrides) crudOverrides = { ...(crudOverrides ?? {}), ...extract.crudOverrides };
  }
  if (crudOverrides) out.crudOverrides = crudOverrides;
  return out;
}

/**
 * Namespace a freshness scan's dir keys by repo so multiple repos with an overlapping
 * relative directory (e.g. both have `src/`) don't overwrite each other's entry in
 * `acquisition.structure`. The repo's own root ("." from scanByDir) becomes just the
 * repo name; every other dir becomes `"<repoName>/<dir>"`.
 *
 * Pre-existing un-prefixed entries from before this fix simply go stale once (they're
 * never written back under the old key) — acceptable, not migrated.
 */
export function prefixScan(scanned: Map<string, FileHashes>, repoName: string): Map<string, FileHashes> {
  const out = new Map<string, FileHashes>();
  for (const [dir, files] of scanned) {
    const key = dir === "." ? repoName : `${repoName}/${dir}`;
    out.set(key, files);
  }
  return out;
}
