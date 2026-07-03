// packages/viewer/src/api.ts
//
// Route map shared by both HTTP servers — cli's startViewer (packages/cli/src/commands/serve.ts)
// and viewer's own dev server (./server.ts) — so their JSON API stays byte-identical. Every
// entry is a zero-arg async producer: model builders read data/ fresh on each request (no
// caching, no server-held state — same "stateless viewer" contract as buildViewModel).
//
// "/transactions.jsonl" is NOT in this map: it's raw ndjson text, not a JSON value, so it
// can't share the `Record<string, () => Promise<unknown>>` shape (a server would have to
// JSON.stringify it, corrupting the ndjson). It's modeled separately as readTransactionsRaw()
// and both servers special-case its path + content-type.
//
// "/api/sitemap.json" resolves to the JSON `null` literal (not `{}`) when
// data/behavior.sitemap.json hasn't been written yet — this mirrors readSitemapModel()'s own
// "not crawled yet" signal one-for-one, so a viewer client can tell "no sitemap" apart from
// "empty sitemap" instead of the two being indistinguishable behind `{}`.

import { readFile } from "node:fs/promises";
import { DATA_FILES, dataPath } from "@crawl-kit/contract";
import { assembleDiff } from "./diff-assemble.js";
import { buildViewModel } from "./view-model.js";
import { buildDashboardModel } from "./dashboard-model.js";
import { buildIntentModel } from "./intent-model.js";
import { buildTrafficModel, readSitemapModel } from "./traffic-model.js";

export const apiRoutes: Record<string, () => Promise<unknown>> = {
  "/api/dashboard.json": buildDashboardModel,
  "/api/intent.json": buildIntentModel,
  "/api/traffic.json": buildTrafficModel,
  "/api/sitemap.json": readSitemapModel,
  "/view-model.json": buildViewModel,
  "/diff.json": () => assembleDiff({}),
};

/** Raw ndjson passthrough for /transactions.jsonl — NOT JSON-stringified by the caller.
 *  Empty string when data/behavior.transactions.jsonl is absent (not yet crawled). */
export async function readTransactionsRaw(): Promise<string> {
  try {
    return await readFile(dataPath(DATA_FILES.behaviorTransactions), "utf8");
  } catch {
    return "";
  }
}
