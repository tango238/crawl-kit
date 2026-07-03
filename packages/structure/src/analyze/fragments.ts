// packages/structure/src/analyze/fragments.ts
//
// Task 2 of the incremental/distributed analyzer: the per-unit *fragment* — the output
// of parsing one unit at one pass — plus a content-addressed disk cache. The cache key is
// (unitId, unitHash, pass): when a unit's content is unchanged its hash is unchanged, so
// the next run reads the cached fragment instead of re-invoking the LLM. That cache hit IS
// the diff-update mechanism; a hash change is an automatic invalidation (a stale key misses).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashContent } from "@crawl-kit/freshness";
import type { ParsedController, ParsedModel, ParsedRoute } from "./source-parser.js";

/** A cross-unit reference discovered during parsing, resolved at merge time. */
export interface FragmentRef {
  /** referrer, e.g. a route or controller id. */
  from: string;
  /** referent, e.g. "UserController" or "User". */
  to: string;
  /** relationship kind, e.g. "route->controller" | "controller->model". */
  kind: string;
}

/** The output of parsing one unit at one pass. Later passes enrich earlier arrays. */
export interface StructureFragment {
  unitId: string;
  /** the unit hash this fragment was produced from — part of the cache key. */
  hash: string;
  /** which pass produced it (1 = route inventory, 2 = detail, 3 = cross-unit). */
  pass: number;
  routes: ParsedRoute[];
  controllers: ParsedController[];
  models: ParsedModel[];
  refs: FragmentRef[];
}

/** A fresh, empty fragment for a unit/pass — the base every parser fills in. */
export function emptyFragment(unitId: string, hash: string, pass: number): StructureFragment {
  return { unitId, hash, pass, routes: [], controllers: [], models: [], refs: [] };
}

/**
 * Path of the cache file for a (unitId, hash, pass). unitId is sanitized for the filesystem;
 * a short hash of the raw id is appended so ids that sanitize to the same string
 * (e.g. "a/b" vs "a:b") never collide.
 */
export function fragmentFile(cacheDir: string, unitId: string, hash: string, pass: number): string {
  const safe = unitId.replace(/[^a-zA-Z0-9]+/g, "_");
  const idKey = hashContent(unitId).slice(0, 8);
  return join(cacheDir, "fragments", `${safe}-${idKey}-${hash}-p${pass}.json`);
}

/** Write a fragment to the cache (creates the fragments/ dir as needed). */
export function writeFragment(cacheDir: string, frag: StructureFragment): void {
  const file = fragmentFile(cacheDir, frag.unitId, frag.hash, frag.pass);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(frag), "utf8");
}

/** Read a cached fragment; null on miss (never written / stale hash / wrong pass / corrupt). */
export function readFragment(
  cacheDir: string,
  unitId: string,
  hash: string,
  pass: number,
): StructureFragment | null {
  const file = fragmentFile(cacheDir, unitId, hash, pass);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StructureFragment;
  } catch {
    return null;
  }
}

/** Default cache directory for a repo. */
export function fragmentsCacheDir(repoPath: string): string {
  return join(repoPath, ".crawl-kit-cache");
}
