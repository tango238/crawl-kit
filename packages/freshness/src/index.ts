// packages/freshness/src/index.ts
export {
  type AcquisitionStore,
  type DirEntry,
  type PageEntry,
  type FileHashes,
  DEFAULT_TTL_SECONDS,
  emptyStore,
} from "./model.js";
export { scanByDir, flatten, hashContent, type ScanOptions } from "./hash.js";
export {
  sameHashes,
  staleDirs,
  recordStructure,
  routeDelta,
  stalePages,
  planBehaviorCrawl,
  recordBehavior,
  type StaleDir,
  type StalePage,
  type StaleReason,
  type RouteDelta,
  type CrawlPlan,
} from "./freshness.js";
export { readStore, writeStore, acquisitionPath } from "./store.js";
