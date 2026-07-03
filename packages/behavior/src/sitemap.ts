// packages/behavior/src/sitemap.ts
//
// Turns the flat navigation graph discovered during crawl (NavEdge[], from services/browser/discover.ts)
// into a tree the viewer can render as a sitemap. Pure and silent — no I/O, no logging; the CLI wiring
// (cli/commands/emit.ts) owns reading behavior.edges.json and writing the result.

import type { NavEdge } from './services/browser/discover.js'

export type SitemapNode = {
  url: string
  via?: { kind: 'link' | 'click'; label?: string }
  children: SitemapNode[]
}

export type Sitemap = {
  generatedAt: string
  roots: SitemapNode[]
  orphans: string[]
}

/** pathname of a URL, falling back to the raw string when it doesn't parse. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

/** Root-like URLs sort first: path "/" first, then shortest path, then alphabetically (determinism). */
function compareRootCandidates(a: string, b: string): number {
  const pa = pathOf(a)
  const pb = pathOf(b)
  if (pa === '/' && pb !== '/') return -1
  if (pb === '/' && pa !== '/') return 1
  if (pa.length !== pb.length) return pa.length - pb.length
  return a.localeCompare(b)
}

/**
 * Build a navigation sitemap tree from discovered edges + visited page URLs. Pure and deterministic.
 *
 * - node set = `pages` ∪ every edge endpoint (`from`/`to`)
 * - each node's parent = the FIRST edge (array order) that reaches it (`edge.to === url`); any later
 *   edge reaching the same node is ignored — multiple parents collapse to the one that wins (DAG → tree)
 * - a parentless node that appears in `edges` (i.e. it's a `from` somewhere, just never a `to`) roots its
 *   own subtree; when several exist, root-like URLs (path "/" first, then shortest) sort first
 * - a parentless node that never appears in `edges` at all — present only in `pages` — is an orphan
 * - cycle-safe: a `visited` set bounds tree construction so a cycle among edges (e.g. A→B→A) can never
 *   recurse forever. In practice the first-parent-wins rule already turns the graph into a strict forest
 *   (a node in a pure cycle never gets a "no parent" node to root from, so that component is simply
 *   unreachable from any root) — the visited set is an extra guard, not the only protection.
 */
export function buildSitemap(
  edges: NavEdge[],
  pages: string[],
  opts: { now?: string } = {},
): Sitemap {
  const parentOf = new Map<string, { from: string; kind: 'link' | 'click'; label?: string }>()
  const inEdges = new Set<string>()

  for (const edge of edges) {
    inEdges.add(edge.from)
    inEdges.add(edge.to)
    if (!parentOf.has(edge.to)) {
      parentOf.set(edge.to, { from: edge.from, kind: edge.kind, label: edge.label })
    }
  }

  const nodes = new Set<string>(pages)
  for (const url of inEdges) nodes.add(url)

  const childrenOf = new Map<string, Array<{ url: string; kind: 'link' | 'click'; label?: string }>>()
  for (const [url, parent] of parentOf) {
    const list = childrenOf.get(parent.from) ?? []
    list.push({ url, kind: parent.kind, label: parent.label })
    childrenOf.set(parent.from, list)
  }

  const rootCandidates: string[] = []
  const orphans: string[] = []
  for (const url of nodes) {
    if (parentOf.has(url)) continue // has a parent — placed as someone's child, not a root/orphan
    if (inEdges.has(url)) rootCandidates.push(url)
    else orphans.push(url)
  }
  rootCandidates.sort(compareRootCandidates)
  orphans.sort()

  const visited = new Set<string>()
  function build(url: string, via?: { kind: 'link' | 'click'; label?: string }): SitemapNode {
    const node: SitemapNode = { url, ...(via ? { via } : {}), children: [] }
    if (visited.has(url)) return node // cycle guard: node itself is kept, its subtree is not re-walked
    visited.add(url)
    for (const child of childrenOf.get(url) ?? []) {
      node.children.push(build(child.url, { kind: child.kind, ...(child.label ? { label: child.label } : {}) }))
    }
    return node
  }

  return {
    generatedAt: opts.now ?? new Date().toISOString(),
    roots: rootCandidates.map((url) => build(url)),
    orphans,
  }
}
