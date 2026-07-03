// packages/freshness/src/freshness.ts
//
// Pure freshness decisions over the store + the current file hashes. No I/O, no
// clock of its own (the caller passes `now`), so it's trivially testable.

import type { AcquisitionStore, FileHashes, PageEntry } from "./model.js";

export type StaleReason = "new" | "ttl" | "changed";
export interface StaleDir {
  dir: string;
  reason: StaleReason;
}
export interface StalePage {
  route: string;
  reason: StaleReason;
}
export interface RouteDelta {
  added: string[];
  removed: string[];
}

function ttlExceeded(at: string, ttlSeconds: number, now: Date): boolean {
  return now.getTime() - Date.parse(at) > ttlSeconds * 1000;
}

/** Same set of paths AND same hash for each — i.e. nothing added/removed/edited. */
export function sameHashes(a: FileHashes, b: FileHashes): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Which directories need a fresh structure acquisition: never seen, TTL elapsed, or
 * any contained file's content hash changed (add/remove/edit/rename all show up).
 */
export function staleDirs(store: AcquisitionStore, current: Map<string, FileHashes>, now: Date): StaleDir[] {
  const out: StaleDir[] = [];
  for (const [dir, files] of current) {
    const prev = store.structure[dir];
    if (!prev) out.push({ dir, reason: "new" });
    else if (ttlExceeded(prev.lastAcquiredAt, store.ttlSeconds, now)) out.push({ dir, reason: "ttl" });
    else if (!sameHashes(prev.files, files)) out.push({ dir, reason: "changed" });
  }
  return out;
}

/** Burn the just-acquired directories into a new store (immutable). */
export function recordStructure(store: AcquisitionStore, acquired: Map<string, FileHashes>, now: Date): AcquisitionStore {
  const structure = { ...store.structure };
  const at = now.toISOString();
  for (const [dir, files] of acquired) structure[dir] = { lastAcquiredAt: at, files: { ...files } };
  return { ...store, structure };
}

/** Route set difference between the previous snapshot and the current structure. */
export function routeDelta(previous: Iterable<string>, current: Iterable<string>): RouteDelta {
  const prev = new Set(previous);
  const curr = new Set(current);
  return {
    added: [...curr].filter((r) => !prev.has(r)),
    removed: [...prev].filter((r) => !curr.has(r)),
  };
}

/**
 * Which pages need a fresh crawl: routes structure just added, never-crawled pages,
 * TTL elapsed, or the page's backing view/route files changed.
 */
export function stalePages(
  store: AcquisitionStore,
  pages: Array<{ route: string; viewFiles: FileHashes }>,
  now: Date,
  addedRoutes: Set<string> = new Set(),
): StalePage[] {
  const out: StalePage[] = [];
  for (const page of pages) {
    const prev = store.behavior[page.route];
    if (addedRoutes.has(page.route) || !prev) out.push({ route: page.route, reason: "new" });
    else if (ttlExceeded(prev.lastCrawledAt, store.ttlSeconds, now)) out.push({ route: page.route, reason: "ttl" });
    else if (!sameHashes(prev.viewFiles, page.viewFiles)) out.push({ route: page.route, reason: "changed" });
  }
  return out;
}

export interface CrawlPlan {
  /** pages to (re)crawl: structure-added, never-crawled, TTL-expired, or view changed. */
  toCrawl: StalePage[];
  /** fresh pages to leave alone. */
  toSkip: string[];
  /** routes that no longer exist in structure → drop their behavior. */
  toDrop: string[];
}

/**
 * The behavior acquisition plan: given the routes structure currently reports,
 * decide what to crawl / skip / drop. `viewHashByRoute` (optional) enables
 * content-change detection per page; without it, only TTL + structure delta apply.
 * loop-e2e calls this before crawling, then `recordBehavior` after.
 */
export function planBehaviorCrawl(
  currentRoutes: Iterable<string>,
  store: AcquisitionStore,
  now: Date,
  viewHashByRoute?: Map<string, FileHashes>,
): CrawlPlan {
  const live = [...new Set(currentRoutes)];
  const { added, removed } = routeDelta(Object.keys(store.behavior), live);
  const pages = live.map((route) => ({
    route,
    viewFiles: viewHashByRoute?.get(route) ?? store.behavior[route]?.viewFiles ?? {},
  }));
  const stale = stalePages(store, pages, now, new Set(added));
  const staleRoutes = new Set(stale.map((s) => s.route));
  return {
    toCrawl: stale,
    toSkip: live.filter((r) => !staleRoutes.has(r)),
    toDrop: removed,
  };
}

/** Burn just-crawled pages into a new store; drop routes that no longer exist. */
export function recordBehavior(
  store: AcquisitionStore,
  crawled: Array<{ route: string; viewFiles: FileHashes }>,
  now: Date,
  liveRoutes?: Iterable<string>,
): AcquisitionStore {
  let behavior: Record<string, PageEntry> = { ...store.behavior };
  const at = now.toISOString();
  for (const page of crawled) behavior[page.route] = { lastCrawledAt: at, viewFiles: { ...page.viewFiles } };
  if (liveRoutes) {
    const live = new Set(liveRoutes);
    behavior = Object.fromEntries(Object.entries(behavior).filter(([route]) => live.has(route)));
  }
  return { ...store, behavior };
}
