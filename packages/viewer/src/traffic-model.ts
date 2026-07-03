// packages/viewer/src/traffic-model.ts
//
// The behavior menu's two sub-views:
//   - 通信ログ (traffic): structure routes (structure:route/ nodes) as the axis,
//     grouped behavior.transactions.jsonl entries joined on the SAME normalized
//     route key the reconciler uses for structure↔behavior (contract's
//     normalizeRoute). Only transactions matching a known structure route are
//     kept — unmatched traffic is noise for this view. Each group's txs carry
//     the `persisted` verdict from the matching behavior:tx/ node when present.
//   - 画面遷移 (sitemap): behavior.sitemap.json passed through untouched.
//
// viewer depends on @crawl-kit/contract only, so the ApiTransaction / LayerNode /
// NavEdge / Sitemap shapes below are LOCAL structural mirrors of behavior's own
// types (transaction.ts, emit.ts, discover.ts, sitemap.ts) — read structurally,
// not imported.
//
// Page ⇄ traffic cross-reference: each tx is stamped (by behavior's recorder) with
// the PAGE URL it fired from. joinPageMutations maps that page URL -> mutation tx
// summaries, and enrichSitemap attaches them onto sitemap nodes so a viewer can see
// "which screen a given data mutation happened on" from either view. Page-level only
// (NOT edge-level "which click fired this tx" — out of scope).
//
// Pure joins (extractStructureRoutes, extractTxPersistence, joinTrafficRoutes,
// joinTrafficPages, joinPageMutations, enrichSitemap) take already-parsed data and are
// unit-tested without I/O.
// buildTrafficModel/readSitemapModel are the tolerant I/O wrappers: missing or
// corrupt files degrade to empty results, unparsable jsonl lines are skipped
// individually — nothing here ever throws.

import { readFile } from "node:fs/promises";
import { DATA_FILES, dataPath, normalizeRoute, readJsonFileOr, resolveRoot } from "@crawl-kit/contract";

type PersistVerdict = "yes" | "no" | "unknown";

export interface TrafficTx {
  seq: number;
  ts: string;
  stage: string;
  status?: number;
  ok: boolean;
  requestQuery?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  persisted?: PersistVerdict;
  /** Origin+pathname of the screen this request fired from (behavior stamps it at record time).
   *  The join key linking a mutation to the sitemap page it happened on. */
  pageUrl?: string;
}

export interface TrafficRouteGroup {
  route: string;
  method: string;
  /** normalizeRoute("METHOD /path") output — the strong join key against a TrafficPage.key
   *  built from the SAME GET route (only equal for GET routes; see pathKey for mutation routes). */
  key: string;
  /** normalizeRoute's path portion only (method stripped) — joins a mutation route (POST/PATCH/…)
   *  to the TrafficPage whose GET route shares the same path, so mutation rows can show screen
   *  elements too (method-inclusive `key` would never match there). */
  pathKey: string;
  txs: TrafficTx[];
}

export interface TrafficPageElement {
  kind: "link" | "click";
  label?: string;
  to: string;
}

export interface TrafficPage {
  url: string;
  /** normalizeRoute("GET " + pathname) — pages are always GET navigations (joinTrafficPages
   *  keeps only URLs matching a known structure GET route). */
  key: string;
  /** Same value as `key` with the method prefix stripped — see TrafficRouteGroup.pathKey. */
  pathKey: string;
  elements: TrafficPageElement[];
}

export interface TrafficModel {
  routes: TrafficRouteGroup[];
  pages: TrafficPage[];
}

/** Structural mirror of behavior's sitemap.ts SitemapNode/Sitemap. */
export interface SitemapNode {
  url: string;
  via?: { kind: "link" | "click"; label?: string };
  children: SitemapNode[];
  /** Mutation txs (non-GET) that fired on this page, attached by enrichSitemap. Absent when none. */
  mutations?: PageMutationSummary[];
}
export interface Sitemap {
  generatedAt: string;
  roots: SitemapNode[];
  orphans: string[];
}

// ---------------------------------------------------------------------------
// Local structural mirrors of upstream (non-contract) shapes.
// ---------------------------------------------------------------------------

/** Structural mirror of contract's LayerNode — only the fields this module reads. */
interface LayerNodeLike {
  nodeId: string;
  route?: string;
  raw?: Record<string, unknown> | null;
  persisted?: PersistVerdict;
}

/** Structural mirror of behavior's domain/transaction.ts ApiTransaction. */
interface ApiTransactionLike {
  seq: number;
  ts: string;
  stage: string;
  method: string;
  path: string;
  status?: number;
  ok: boolean;
  requestQuery?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  pageUrl?: string;
}

/** Structural mirror of behavior's services/browser/discover.ts NavEdge. */
interface NavEdgeLike {
  from: string;
  to: string;
  kind: "link" | "click";
  label?: string;
}

interface EdgesDocLike {
  edges?: NavEdgeLike[];
}

export interface StructureRoute {
  /** raw "METHOD /path" key as structure emitted it (unnormalized). */
  route: string;
  method: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Pure joins
// ---------------------------------------------------------------------------

/** The path-only portion of normalizeRoute's output (method stripped) — a method-agnostic
 *  join key so a mutation route (POST/PATCH/DELETE) can still be matched to the GET page
 *  that renders its screen elements. normalizeRoute's path normalization doesn't depend on
 *  the method, so prefixing with a fixed "GET " and slicing it back off is safe. */
function pathKeyOf(path: string): string {
  const normalized = normalizeRoute(`GET ${path}`);
  const spaceIdx = normalized.indexOf(" ");
  return spaceIdx === -1 ? normalized : normalized.slice(spaceIdx + 1);
}

/** structure:route/ nodes → {route, method, path}. */
export function extractStructureRoutes(nodes: LayerNodeLike[]): StructureRoute[] {
  return nodes
    .filter((n) => n.nodeId.startsWith("structure:route/"))
    .map((n) => {
      const route = n.route ?? n.nodeId.slice("structure:route/".length);
      const rawMethod = n.raw?.method;
      const rawPath = n.raw?.path;
      const method = (typeof rawMethod === "string" ? rawMethod : route.split(" ")[0] ?? "GET").toUpperCase();
      const path = typeof rawPath === "string" ? rawPath : route.slice(method.length + 1);
      return { route, method, path };
    });
}

/** behavior:tx/ nodes → normalized-route-key → persisted verdict.
 *  Mutation nodes are now emitted ONE-per-transaction (nodeId "behavior:tx/<route>#<seq>"),
 *  so several nodes can share a `route`. Keying by `route` collapses them to a single, stable
 *  per-route verdict (they're identical — the verdict is route-derived), keeping this route-level
 *  aggregation view unchanged. The nodeId fallback strips any "#<seq>" suffix for the rare case
 *  a node carries no `route`. */
export function extractTxPersistence(nodes: LayerNodeLike[]): Map<string, PersistVerdict> {
  const map = new Map<string, PersistVerdict>();
  for (const n of nodes) {
    if (!n.nodeId.startsWith("behavior:tx/")) continue;
    if (!n.persisted) continue;
    const key = n.route ?? n.nodeId.slice("behavior:tx/".length).replace(/#\d+$/, "");
    map.set(key, n.persisted);
  }
  return map;
}

/**
 * Group transactions by their normalized route key, keeping only groups that
 * match a known structure route. `persistedByKey` is keyed the same way
 * (normalizeRoute'd), from extractTxPersistence.
 */
export function joinTrafficRoutes(
  structureRoutes: StructureRoute[],
  txs: ApiTransactionLike[],
  persistedByKey: Map<string, PersistVerdict>,
): TrafficRouteGroup[] {
  const byKey = new Map<string, StructureRoute>();
  for (const r of structureRoutes) {
    const key = normalizeRoute(r.route);
    if (!byKey.has(key)) byKey.set(key, r);
  }

  const groups = new Map<string, TrafficRouteGroup>();
  for (const t of txs) {
    const key = normalizeRoute(`${t.method} ${t.path}`);
    const routeInfo = byKey.get(key);
    if (!routeInfo) continue; // no matching structure route — excluded per spec

    const persisted = persistedByKey.get(key);
    const group = groups.get(key) ?? {
      route: routeInfo.route,
      method: routeInfo.method.toUpperCase(),
      key,
      pathKey: pathKeyOf(routeInfo.path),
      txs: [],
    };
    group.txs.push({
      seq: t.seq,
      ts: t.ts,
      stage: t.stage,
      ...(t.status !== undefined ? { status: t.status } : {}),
      ok: t.ok,
      ...(t.requestQuery ? { requestQuery: t.requestQuery } : {}),
      ...(t.requestBody !== undefined ? { requestBody: t.requestBody } : {}),
      ...(t.responseBody !== undefined ? { responseBody: t.responseBody } : {}),
      ...(persisted ? { persisted } : {}),
      ...(t.pageUrl ? { pageUrl: t.pageUrl } : {}),
    });
    groups.set(key, group);
  }

  return [...groups.values()];
}

/** pathname of a URL, or the raw string when it's already a bare path / doesn't parse. */
function urlPath(url: string): string | null {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url.startsWith("/") ? url : null;
  }
}

/**
 * Group edges by `from` into {url, elements}, keeping only pages whose path
 * matches a known structure GET route (page navigations are always GETs).
 */
export function joinTrafficPages(edges: NavEdgeLike[], structureRoutes: StructureRoute[]): TrafficPage[] {
  const getRouteKeys = new Set<string>();
  for (const r of structureRoutes) {
    if (r.method.toUpperCase() === "GET") getRouteKeys.add(normalizeRoute(r.route));
  }

  const order: string[] = [];
  const elementsByFrom = new Map<string, TrafficPageElement[]>();
  for (const e of edges) {
    if (!elementsByFrom.has(e.from)) {
      elementsByFrom.set(e.from, []);
      order.push(e.from);
    }
    elementsByFrom.get(e.from)!.push({ kind: e.kind, ...(e.label ? { label: e.label } : {}), to: e.to });
  }

  const pages: TrafficPage[] = [];
  for (const url of order) {
    const path = urlPath(url);
    if (path === null) continue;
    const key = normalizeRoute(`GET ${path}`);
    if (!getRouteKeys.has(key)) continue;
    pages.push({ url, key, pathKey: pathKeyOf(path), elements: elementsByFrom.get(url)! });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Page ⇄ mutation cross-reference
//
// Page-level only: this links a mutation tx to the SCREEN it fired on (its owning
// page URL, stamped by behavior's recorder), NOT the exact click/link that
// triggered it — NavEdges and txs share no time axis, so edge-level temporal
// correlation is deliberately out of scope.
// ---------------------------------------------------------------------------

/** A non-GET tx summarized for the sitemap's "mutations on this page" cross-reference. */
export interface PageMutationSummary {
  seq: number;
  ts: string;
  method: string;
  path: string;
  stage: string;
  status?: number;
  ok: boolean;
}

/** Origin+pathname, dropping query/fragment and trailing slash — mirrors behavior's
 *  discover.ts normalizeUrl so BOTH sides (tx.pageUrl and sitemap node.url) key identically. */
function normalizePageUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}

/**
 * Map normalized page URL → the mutation (non-GET) tx summaries that fired on that page.
 * txs with no pageUrl are skipped. The key matches sitemap node.url via normalizePageUrl.
 */
export function joinPageMutations(txs: ApiTransactionLike[]): Map<string, PageMutationSummary[]> {
  const map = new Map<string, PageMutationSummary[]>();
  for (const t of txs) {
    if (!t.pageUrl) continue;
    if (t.method.toUpperCase() === "GET") continue;
    const key = normalizePageUrl(t.pageUrl);
    const list = map.get(key) ?? [];
    list.push({
      seq: t.seq,
      ts: t.ts,
      method: t.method.toUpperCase(),
      path: t.path,
      stage: t.stage,
      ...(t.status !== undefined ? { status: t.status } : {}),
      ok: t.ok,
    });
    map.set(key, list);
  }
  return map;
}

/** Recursively attach mutation summaries to sitemap nodes whose normalized url matches a key.
 *  Pure + immutable: returns new nodes, input is never mutated. */
function enrichSitemapNodes(nodes: SitemapNode[], mutationsByUrl: Map<string, PageMutationSummary[]>): SitemapNode[] {
  return nodes.map((n) => {
    const children = Array.isArray(n.children) ? n.children : [];
    const mutations = mutationsByUrl.get(normalizePageUrl(n.url));
    return {
      ...n,
      children: enrichSitemapNodes(children, mutationsByUrl),
      ...(mutations && mutations.length ? { mutations } : {}),
    };
  });
}

/** Enrich a whole sitemap with per-page mutation cross-references (immutably). */
export function enrichSitemap(sitemap: Sitemap, mutationsByUrl: Map<string, PageMutationSummary[]>): Sitemap {
  return { ...sitemap, roots: enrichSitemapNodes(Array.isArray(sitemap.roots) ? sitemap.roots : [], mutationsByUrl) };
}

// ---------------------------------------------------------------------------
// I/O wrappers — tolerant of missing/corrupt files, never throw.
// ---------------------------------------------------------------------------

async function readJsonlOr<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip unparsable line — one bad record shouldn't sink the whole view
    }
  }
  return out;
}

export async function buildTrafficModel(): Promise<TrafficModel> {
  const root = resolveRoot();
  const structureNodes = await readJsonFileOr<LayerNodeLike[]>(dataPath(DATA_FILES.structureNodes, root), []);
  const behaviorNodes = await readJsonFileOr<LayerNodeLike[]>(dataPath(DATA_FILES.behaviorNodes, root), []);
  const txs = await readJsonlOr<ApiTransactionLike>(dataPath(DATA_FILES.behaviorTransactions, root));
  const edgesDoc = await readJsonFileOr<EdgesDocLike>(dataPath(DATA_FILES.behaviorEdges, root), { edges: [] });

  const structureRoutes = extractStructureRoutes(structureNodes);
  const persistedByKey = extractTxPersistence(behaviorNodes);

  return {
    routes: joinTrafficRoutes(structureRoutes, txs, persistedByKey),
    pages: joinTrafficPages(edgesDoc.edges ?? [], structureRoutes),
  };
}

export async function readSitemapModel(): Promise<Sitemap | null> {
  const root = resolveRoot();
  const sitemap = await readJsonFileOr<Sitemap | null>(dataPath(DATA_FILES.behaviorSitemap, root), null);
  if (!sitemap) return null;
  // Cross-reference: stamp each page node with the mutation txs that fired on it. Tolerant —
  // a missing transactions file yields an empty map, leaving the sitemap effectively untouched.
  const txs = await readJsonlOr<ApiTransactionLike>(dataPath(DATA_FILES.behaviorTransactions, root));
  return enrichSitemap(sitemap, joinPageMutations(txs));
}
