// packages/reconciler/src/match/route.ts
//
// normalizeRoute now lives on the spine (packages/contract/src/route.ts) — the viewer joins
// communication-log routes and depends on contract only, not reconciler. Re-exported here so
// existing import sites (`@crawl-kit/reconciler`, `./match/route.js`) keep working unchanged.

export { normalizeRoute } from "@crawl-kit/contract";
