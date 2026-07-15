// Route coverage: match a run's recorded ApiTransactions against the expected-route inventory
// (the denominator from routeInventory.ts) and track, cumulatively across runs, which routes have
// been exercised. The inventory is authoritative — entries follow inventory order, prior coverage
// state is carried forward per key, and keys no longer in the inventory are dropped. Pure core
// (updateCoverage / renderCoverageMarkdown take an explicit `now`/`runId` for determinism) with
// thin JSON+Markdown IO helpers on top.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeRoute } from '@crawl-kit/reconciler'
import { logger } from '../../util/logger.js'
import { statePaths } from '../../state/paths.js'
import type { ApiTransaction } from '../../domain/transaction.js'
import type { RouteInventory } from './routeInventory.js'

export type CoverageEntry = {
  key: string
  method: string
  path: string
  covered: boolean
  firstCoveredRunId?: string
  lastCoveredAt?: string
  screens?: string[]
}
export type CoverageStore = { source: string; updatedAt: string; total: number; covered: number; entries: CoverageEntry[] }
export type CoverageSummary = { total: number; covered: number; newlyCovered: number; ratio: number /* 0..1, 0 when total 0 */ }

const COVERAGE_JSON = 'coverage.json'
const COVERAGE_MD = 'coverage.md'

/** Union two screen lists into a sorted, deduped list; undefined when both are empty. */
function unionScreens(prev: string[] | undefined, next: Iterable<string>): string[] | undefined {
  const set = new Set<string>(prev ?? [])
  for (const s of next) set.add(s)
  if (set.size === 0) return undefined
  return [...set].sort()
}

/** Screen label for a tx's owning page: its pathname when parseable (matches the session log's
 *  grouping), else the raw pageUrl. */
function screenLabel(pageUrl: string): string {
  try {
    return new URL(pageUrl).pathname
  } catch {
    return pageUrl
  }
}

/**
 * Recompute coverage from the inventory (authoritative denominator) and this run's transactions.
 * Only transactions that got a response (`status != null`) can cover a route. Coverage is
 * cumulative: a route stays covered once covered, keeping its first-covered run id; screens
 * accumulate the union of owning-page paths across runs.
 */
export function updateCoverage(
  prev: CoverageStore | null,
  inventory: RouteInventory,
  txs: ApiTransaction[],
  runId: string,
  now: string,
): { store: CoverageStore; summary: CoverageSummary } {
  // This run's matches, keyed by normalized route → the screens the matching txs fired from.
  const matchedScreens = new Map<string, Set<string>>()
  for (const tx of txs) {
    if (tx.status == null) continue
    const key = normalizeRoute(`${tx.method} ${tx.path}`)
    const screens = matchedScreens.get(key) ?? new Set<string>()
    if (tx.pageUrl) screens.add(screenLabel(tx.pageUrl))
    matchedScreens.set(key, screens)
  }

  const prevByKey = new Map((prev?.entries ?? []).map((e) => [e.key, e]))
  let newlyCovered = 0

  const entries: CoverageEntry[] = inventory.routes.map((route) => {
    const prevEntry = prevByKey.get(route.key)
    const matchedThisRun = matchedScreens.has(route.key)
    const covered = (prevEntry?.covered ?? false) || matchedThisRun
    if (matchedThisRun && !(prevEntry?.covered ?? false)) newlyCovered++

    const screens = matchedThisRun
      ? unionScreens(prevEntry?.screens, matchedScreens.get(route.key) ?? [])
      : prevEntry?.screens

    return {
      key: route.key,
      method: route.method,
      path: route.path,
      covered,
      firstCoveredRunId: prevEntry?.firstCoveredRunId ?? (matchedThisRun ? runId : undefined),
      lastCoveredAt: matchedThisRun ? now : prevEntry?.lastCoveredAt,
      screens,
    }
  })

  const coveredCount = entries.filter((e) => e.covered).length
  const total = entries.length
  const store: CoverageStore = { source: inventory.source, updatedAt: now, total, covered: coveredCount, entries }
  const summary: CoverageSummary = {
    total,
    covered: coveredCount,
    newlyCovered,
    ratio: total === 0 ? 0 : coveredCount / total,
  }
  return { store, summary }
}

/** Human-readable coverage report (Japanese labels), split into uncovered and covered checklists. */
export function renderCoverageMarkdown(store: CoverageStore): string {
  const pct = store.total === 0 ? '0.0' : ((store.covered / store.total) * 100).toFixed(1)
  const uncovered = store.entries.filter((e) => !e.covered)
  const covered = store.entries.filter((e) => e.covered)

  const lines: string[] = ['# ルート網羅状況', '']
  lines.push(`**${store.covered} / ${store.total} routes (${pct}%)** — 更新: ${store.updatedAt} (source: ${store.source})`, '')

  lines.push(`## 未網羅 (${uncovered.length})`, '')
  for (const e of uncovered) lines.push(`- [ ] ${e.method} ${e.path}`)
  lines.push('')

  lines.push(`## 網羅済み (${covered.length})`, '')
  for (const e of covered) {
    const screens = e.screens?.length ? ` — screens: ${e.screens.join(', ')}` : ''
    const last = e.lastCoveredAt ? ` (last: ${e.lastCoveredAt})` : ''
    lines.push(`- [x] ${e.method} ${e.path}${screens}${last}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Load the persisted coverage store; null when missing, and null (with a warning) when corrupt. */
export async function loadCoverageStore(root: string): Promise<CoverageStore | null> {
  const path = join(statePaths(root).explore, COVERAGE_JSON)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(text) as CoverageStore
  } catch (err) {
    logger.warn({ err: String(err), path }, 'coverage: corrupt coverage.json — ignoring')
    return null
  }
}

/** Persist the coverage store as coverage.json (pretty) + coverage.md under the explore state dir. */
export async function saveCoverageStore(root: string, store: CoverageStore): Promise<void> {
  const dir = statePaths(root).explore
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, COVERAGE_JSON), `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await writeFile(join(dir, COVERAGE_MD), renderCoverageMarkdown(store), 'utf8')
}
