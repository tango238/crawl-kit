// packages/freshness/src/model.ts
//
// The acquisition-freshness store (data/acquisition.json). It separates the
// ACQUISITION UNIT (what re-runs: a directory for structure, a route/page for
// behavior) from the CHANGE SIGNAL (per-file content hashes — cheap, local).
// Re-acquire when the TTL elapsed OR the contained files' hashes changed.

/** path → content hash, for the files watched under one unit. */
export type FileHashes = Record<string, string>;

export interface DirEntry {
  /** ISO timestamp of the last structure acquisition for this directory. */
  lastAcquiredAt: string;
  /** content hashes of the files in this directory at that time. */
  files: FileHashes;
}

export interface PageEntry {
  /** ISO timestamp of the last behavior crawl for this route/page. */
  lastCrawledAt: string;
  /** content hashes of the view/route files backing this page. */
  viewFiles: FileHashes;
}

export interface AcquisitionStore {
  /** single TTL shared by structure and behavior. */
  ttlSeconds: number;
  /** structure freshness, keyed by directory (relative path). */
  structure: Record<string, DirEntry>;
  /** behavior freshness, keyed by route. */
  behavior: Record<string, PageEntry>;
}

export const DEFAULT_TTL_SECONDS = 86_400; // 1 day

export function emptyStore(ttlSeconds: number = DEFAULT_TTL_SECONDS): AcquisitionStore {
  return { ttlSeconds, structure: {}, behavior: {} };
}
