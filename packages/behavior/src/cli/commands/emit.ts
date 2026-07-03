import { dirname, join } from 'node:path'
import { mkdir, writeFile, readFile, readdir, stat, copyFile } from 'node:fs/promises'
import { DATA_FILES, dataPath, readJsonFileOr, writeJsonAtomic } from '@crawl-kit/contract'
import { loadLatestReport } from '../../state/store.js'
import { statePaths } from '../../state/paths.js'
import { emitBehaviorAll } from '../../emit.js'
import { TRANSACTIONS_SUFFIX } from '../../domain/transaction.js'
import type { ApiTransaction } from '../../domain/transaction.js'
import { CRUD_SAVED_SUFFIX, CRUD_RESULTS_SUFFIX } from '../../services/crud/types.js'
import type { CrudEntityResult } from '../../services/crud/types.js'
import { logger } from '../../util/logger.js'
import { buildSitemap } from '../../sitemap.js'
import { normalizeUrl } from '../../services/browser/discover.js'
import type { NavEdge } from '../../services/browser/discover.js'

export type RunEmitDeps = {
  loadConfig?: (root: string) => Promise<unknown>
}

export type RunEmitResult = { count: number; outPath: string; transactions: number }

/** Find the newest *.transactions.jsonl in .e2e/runs (by mtime); [] if none. */
async function loadLatestTransactions(root: string): Promise<{ txs: ApiTransaction[]; file: string | null }> {
  const runsDir = statePaths(root).runs
  let files: string[]
  try {
    files = await readdir(runsDir)
  } catch {
    return { txs: [], file: null }
  }
  const cand = files.filter((f) => f.endsWith(TRANSACTIONS_SUFFIX))
  if (cand.length === 0) return { txs: [], file: null }
  const withMtime = await Promise.all(cand.map(async (f) => ({ f, m: (await stat(join(runsDir, f))).mtimeMs })))
  withMtime.sort((a, b) => a.m - b.m)
  const latest = withMtime[withMtime.length - 1].f
  const txt = await readFile(join(runsDir, latest), 'utf8').catch(() => '')
  const txs = txt
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ApiTransaction]
      } catch {
        return []
      }
    })
  return { txs, file: join(runsDir, latest) }
}

/**
 * Load the latest run's SiteStructure and emit it as crawl-kit behavior LayerNodes
 * (data/behavior.nodes.json on the crawl-kit spine). The replacement for `rdra-export`.
 * Also bridges the latest run's recorded API transactions into data/ so the viewer
 * (which only reads data/) can serve them.
 */
/** Load the newest *.crud-saved.json in .e2e/runs (route → saved columns); {} if none. */
async function loadLatestSaved(root: string): Promise<Record<string, string[]>> {
  const runsDir = statePaths(root).runs
  let files: string[]
  try {
    files = await readdir(runsDir)
  } catch {
    return {}
  }
  const cand = files.filter((f) => f.endsWith(CRUD_SAVED_SUFFIX))
  if (cand.length === 0) return {}
  const withMtime = await Promise.all(cand.map(async (f) => ({ f, m: (await stat(join(runsDir, f))).mtimeMs })))
  withMtime.sort((a, b) => a.m - b.m)
  const latest = withMtime[withMtime.length - 1].f
  try {
    return JSON.parse(await readFile(join(runsDir, latest), 'utf8')) as Record<string, string[]>
  } catch {
    return {}
  }
}

/** Load the newest *.crud-results.json in .e2e/runs (full per-step CRUD results); `null` when
 *  no such artifact exists (crud never ran for this run) — distinct from an actual empty array,
 *  so emit can tell "never checked" (no persisted annotation at all) apart from "checked, no
 *  match" (see emit.ts#emitTransactionNodes). */
async function loadLatestCrudResults(root: string): Promise<CrudEntityResult[] | null> {
  const runsDir = statePaths(root).runs
  let files: string[]
  try {
    files = await readdir(runsDir)
  } catch {
    return null
  }
  const cand = files.filter((f) => f.endsWith(CRUD_RESULTS_SUFFIX))
  if (cand.length === 0) return null
  const withMtime = await Promise.all(cand.map(async (f) => ({ f, m: (await stat(join(runsDir, f))).mtimeMs })))
  withMtime.sort((a, b) => a.m - b.m)
  const latest = withMtime[withMtime.length - 1].f
  try {
    return JSON.parse(await readFile(join(runsDir, latest), 'utf8')) as CrudEntityResult[]
  } catch {
    return null
  }
}

export async function runEmit(root: string, _deps: RunEmitDeps = {}): Promise<RunEmitResult> {
  const structure = await loadLatestReport(root)
  if (!structure) {
    throw new Error('no run found — run `loop-e2e run` first')
  }

  const { txs, file } = await loadLatestTransactions(root)
  const savedByRoute = await loadLatestSaved(root)
  const crudResults = await loadLatestCrudResults(root)
  const nodes = emitBehaviorAll(structure, null, undefined, txs, savedByRoute, crudResults)

  const outPath = dataPath(DATA_FILES.behaviorNodes, root)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(nodes, null, 2)}\n`, 'utf8')

  // Bridge the raw jsonl into data/ so the viewer (which only reads data/) can serve it.
  const txOut = dataPath(DATA_FILES.behaviorTransactions, root)
  if (file) {
    await copyFile(file, txOut).catch((err) => logger.warn({ err: String(err) }, 'emit: transaction bridge failed'))
  } else {
    await writeFile(txOut, '', 'utf8').catch(() => {})
  }

  // Build data/behavior.sitemap.json from the navigation edges recorded during collect
  // (data/behavior.edges.json, written by the crawl BFS — see pipeline/collect.ts). No edges
  // file yet (e.g. a run predating that feature, or a run with no browser) → skip silently;
  // there's nothing to build a sitemap from.
  const edgesData = await readJsonFileOr<{ runId?: string; edges: NavEdge[] } | null>(
    dataPath(DATA_FILES.behaviorEdges, root),
    null,
  )
  if (edgesData) {
    // Edges are already normalizeUrl'd (discover.ts records them that way — see NavEdge doc
    // comment). Page URLs from the crawled structure are the raw finalUrl (query string/
    // redirect target intact), so without normalizing them here a page reached via a link with
    // a query string would fail to join its edge node and surface as a false orphan.
    const pageUrls = structure.pages.map((page) => normalizeUrl(page.url))
    const sitemap = buildSitemap(edgesData.edges, pageUrls)
    await writeJsonAtomic(dataPath(DATA_FILES.behaviorSitemap, root), sitemap)
  }

  return { count: nodes.length, outPath, transactions: txs.length }
}
