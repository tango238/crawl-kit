// packages/behavior/src/emit.ts
//
// The crawl-kit replacement for loop-e2e's `rdra-export`. Instead of stitching adopted
// scenarios point-to-point into rdra-analyzer's analysis_result.json, the behavior layer
// EMITS its observations onto the shared spine: each crawled page becomes a route-keyed
// contract LayerNode, and the reconciler does every join. (STRUCTURE.md: "旧 rdra-export
// の正しい姿".)

import type { LayerNode } from '@crawl-kit/contract'
import { normalizeRoute } from '@crawl-kit/reconciler'
import type { Report, SiteStructure, Transition, VerifyFinding } from './domain/types.js'
import type { ApiTransaction } from './domain/transaction.js'
import { annotatePersistence } from './tx-persistence.js'
import type { CrudResultsLike } from './tx-persistence.js'

const TOOL = 'loop-e2e' as const

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** pathname of a crawled URL, falling back to the raw string. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    const m = url.match(/^[a-z]+:\/\/[^/]+(\/[^?#]*)/i)
    return m?.[1] ?? url
  }
}

/** "GET /orders/123" from a crawled page URL (method is GET — pages are navigations). */
function routeKey(url: string): string {
  return `GET ${pathOf(url)}`
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root'
}

/** findings whose evidence/location mentions this page url, attached to its node. */
function findingsForPage(url: string, report: Report | null): VerifyFinding[] {
  if (!report) return []
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    /* keep as-is */
  }
  return report.verifyFindings.filter(
    (f) => f.evidence.includes(url) || (pathname && f.evidence.includes(pathname)),
  )
}

/**
 * Emit behavior LayerNodes for one run: one node per crawled page, keyed by its route,
 * carrying what was observed running (expectations/capabilities/inputs) plus any verify
 * findings located there. The reconciler normalizes the route and joins to structure.
 */
export function emitBehaviorNodes(
  structure: SiteStructure,
  report: Report | null = null,
  runId?: string,
): LayerNode[] {
  return structure.pages.map((page) => {
    const key = routeKey(page.url)
    const findings = findingsForPage(page.url, report)
    return {
      nodeId: `behavior:page/${key}`,
      layer: 'behavior' as const,
      localName: key,
      raw: {
        url: page.url,
        title: page.title,
        expectations: page.expectations,
        capabilities: page.capabilities,
        displayItems: page.displayItems,
        inputItems: page.inputItems,
        findings,
      },
      route: key,
      source: { tool: TOOL, ...(runId ? { runId } : {}) },
    }
  })
}

/**
 * Emit the observed navigations as behavior state-transition nodes — the runtime
 * counterpart of the intent/structure transition axis. These are UI-level (one page
 * to another via a trigger); aligning them to DOMAIN state names needs the
 * route→entity→concept join (the reconciler), but the spine carries them so the diff
 * view has a behavior column to fill.
 */
export function emitBehaviorTransitionNodes(structure: SiteStructure, runId?: string): LayerNode[] {
  return structure.transitions.map((t: Transition) => ({
    nodeId: `behavior:transition/${slug(pathOf(t.fromUrl))}--${slug(pathOf(t.toUrl))}`,
    layer: 'behavior' as const,
    localName: `${pathOf(t.fromUrl)} → ${pathOf(t.toUrl)}`,
    raw: {
      kind: 'transition',
      from: pathOf(t.fromUrl),
      to: pathOf(t.toUrl),
      trigger: t.trigger,
      fromUrl: t.fromUrl,
      toUrl: t.toUrl,
    },
    route: routeKey(t.toUrl),
    source: { tool: TOOL, ...(runId ? { runId } : {}) },
  }))
}

/**
 * Emit method-aware behavior nodes from recorded API transactions. Page nodes
 * cover GET navigations; these cover mutations (POST/PUT/PATCH/DELETE) so the
 * reconciler/boundary can pair them with structure's method-keyed routes.
 *
 * MUTATING methods: ONE node per recorded transaction — repeated same-route mutations
 * (e.g. three `POST /orders`) stay individually visible instead of collapsing to one.
 * The nodeId gains a `#${seq}` suffix for uniqueness; `route` stays the normalized
 * "METHOD /path" so the reconciler/boundary still group by route. The `persisted`
 * verdict is ROUTE-DERIVED (annotatePersistence keys by route), so every same-route
 * mutation node shares the same verdict — expected and correct here: the CRUD executor
 * issues its own synthetic requests and only knows routes, so a distinct DB probe per
 * recorded browser tx would be an oracle redesign. Full per-transaction DB probing is
 * future work (out of scope); this change gives per-transaction VISIBILITY only.
 *
 * NON-mutating methods (GET/HEAD/OPTIONS): skipped as before — pages already cover
 * navigations, they carry no persisted verdict, and per-tx nodes would only explode the
 * node count. No dedup array is needed because at most one code path emits them (none).
 */
export function emitTransactionNodes(
  txs: ApiTransaction[],
  runId?: string,
  savedByRoute?: Record<string, string[]>,
  crudResults?: CrudResultsLike | null,
): LayerNode[] {
  const nodes: LayerNode[] = []
  for (const t of txs) {
    const method = t.method.toUpperCase()
    if (!MUTATING.has(method)) continue
    const key = normalizeRoute(`${method} ${t.path}`)
    const saved = savedByRoute?.[key]
    // crudResults is null/undefined when no CRUD artifact exists for this run (crud never ran,
    // or emit found no matching *.crud-results.json) — persisted is left off entirely rather
    // than defaulting to "unknown" (that would misrepresent "never checked" as "checked, no
    // match"). See tx-persistence.ts and services/crud/types.ts#CRUD_RESULTS_SUFFIX.
    const persisted = crudResults != null ? annotatePersistence({ method, path: t.path }, crudResults) : undefined
    nodes.push({
      nodeId: `behavior:tx/${key}#${t.seq}`,
      layer: 'behavior' as const,
      localName: key,
      raw: {
        kind: 'transaction',
        method,
        path: t.path,
        status: t.status,
        ok: t.ok,
        // `saved` filled from the CRUD executor (C/D); absent when persistence wasn't probed.
        ...(saved ? { saved } : {}),
      },
      route: key,
      // per-transaction identity (unique with runId) — keeps repeated same-route mutations distinct.
      seq: t.seq,
      source: { tool: TOOL, ...(runId ? { runId } : {}) },
      // oracle verdict from this run's CRUD results — undefined when no crudResults were
      // supplied (never wired) or the tx's method carries no persistence question (never here;
      // GET/HEAD/OPTIONS are filtered by MUTATING above, but annotatePersistence stays defensive).
      ...(persisted ? { persisted } : {}),
    })
  }
  return nodes
}

/** All behavior nodes for one run: page observations + observed transitions + API transactions. */
export function emitBehaviorAll(
  structure: SiteStructure,
  report: Report | null = null,
  runId?: string,
  txs: ApiTransaction[] = [],
  savedByRoute?: Record<string, string[]>,
  crudResults?: CrudResultsLike | null,
): LayerNode[] {
  return [
    ...emitBehaviorNodes(structure, report, runId),
    ...emitBehaviorTransitionNodes(structure, runId),
    ...emitTransactionNodes(txs, runId, savedByRoute, crudResults),
  ]
}
