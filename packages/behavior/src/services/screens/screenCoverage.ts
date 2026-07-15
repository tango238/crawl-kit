// Screen coverage: match a run's visited pages against the static screen inventory (the denominator
// from inventory.ts) and track, cumulatively across runs, which screens have been reached. Mirrors
// routeCoverage.ts (API routes) exactly: the inventory is authoritative — entries follow inventory
// order keyed by normalized path, prior coverage is carried forward per key, and keys no longer in
// the inventory are dropped. Pure core (updateScreenCoverage / renderScreenCoverageMarkdown take an
// explicit `now`/`runId` for determinism) with thin JSON+Markdown IO helpers on top.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../../util/logger.js'
import { statePaths } from '../../state/paths.js'
import type { ScreenInventory } from './inventory.js'

export type ScreenCoverageEntry = {
  key: string
  path: string
  covered: boolean
  firstCoveredRunId?: string
  lastCoveredAt?: string
}
export type ScreenCoverageStore = {
  source: string
  updatedAt: string
  total: number
  covered: number
  entries: ScreenCoverageEntry[]
}
export type ScreenCoverageSummary = { total: number; covered: number; newlyCovered: number; ratio: number /* 0..1, 0 when total 0 */ }

const COVERAGE_JSON = 'screen-coverage.json'
const COVERAGE_MD = 'screen-coverage.md'

const NUMERIC = /^\d+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_ID = /^[0-9a-f]{16,}$/i

/** Does this path segment look like an identifier (concrete id or a templated param) rather than a
 *  fixed screen name? Mirrors contract/route.ts's isParamSegment so templated `:id`/`[id]` inventory
 *  paths and the concrete `/hotel/123` a crawl visits collapse to the same key. */
function isIdSegment(segment: string): boolean {
  if (segment.startsWith(':')) return true // templated `:param`
  if (segment.startsWith('[') && segment.endsWith(']')) return true // `[param]` style
  if (NUMERIC.test(segment)) return true
  if (UUID.test(segment)) return true
  if (HEX_ID.test(segment)) return true
  return false
}

/**
 * Normalize a screen path (templated `/hotel/:id` or concrete `/hotel/123`) into a canonical match
 * key: lower-cased, query/hash stripped, trailing slash removed (root preserved), and id-shaped
 * segments collapsed to `:id`.
 */
export function normalizeScreenPath(p: string): string {
  const pathOnly = p.split(/[?#]/)[0] ?? ''
  const segments = pathOnly
    .toLowerCase()
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (isIdSegment(s) ? ':id' : s))
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

/**
 * Recompute coverage from the inventory (authoritative denominator) and this run's visited page
 * paths. `visitedPaths` are concrete pathnames (e.g. `/hotel/123`); both sides are matched via
 * {@link normalizeScreenPath}. Coverage is cumulative: a screen stays covered once covered, keeping
 * its first-covered run id. Inventory screens that collapse to the same key are de-duplicated
 * (first occurrence wins) so `total` counts distinct screens.
 */
export function updateScreenCoverage(
  prev: ScreenCoverageStore | null,
  inventory: ScreenInventory,
  visitedPaths: string[],
  runId: string,
  now: string,
): { store: ScreenCoverageStore; summary: ScreenCoverageSummary } {
  const visitedKeys = new Set(visitedPaths.map(normalizeScreenPath))
  const prevByKey = new Map((prev?.entries ?? []).map((e) => [e.key, e]))
  let newlyCovered = 0

  const seen = new Set<string>()
  const entries: ScreenCoverageEntry[] = []
  for (const screen of inventory.screens) {
    const key = normalizeScreenPath(screen.path)
    if (seen.has(key)) continue
    seen.add(key)

    const prevEntry = prevByKey.get(key)
    const matchedThisRun = visitedKeys.has(key)
    const covered = (prevEntry?.covered ?? false) || matchedThisRun
    if (matchedThisRun && !(prevEntry?.covered ?? false)) newlyCovered++

    entries.push({
      key,
      path: screen.path,
      covered,
      firstCoveredRunId: prevEntry?.firstCoveredRunId ?? (matchedThisRun ? runId : undefined),
      lastCoveredAt: matchedThisRun ? now : prevEntry?.lastCoveredAt,
    })
  }

  const coveredCount = entries.filter((e) => e.covered).length
  const total = entries.length
  const store: ScreenCoverageStore = { source: inventory.source, updatedAt: now, total, covered: coveredCount, entries }
  const summary: ScreenCoverageSummary = {
    total,
    covered: coveredCount,
    newlyCovered,
    ratio: total === 0 ? 0 : coveredCount / total,
  }
  return { store, summary }
}

/** Human-readable coverage report (Japanese labels), split into uncovered and covered checklists. */
export function renderScreenCoverageMarkdown(store: ScreenCoverageStore): string {
  const pct = store.total === 0 ? '0.0' : ((store.covered / store.total) * 100).toFixed(1)
  const uncovered = store.entries.filter((e) => !e.covered)
  const covered = store.entries.filter((e) => e.covered)

  const lines: string[] = ['# 画面網羅状況', '']
  lines.push(`**${store.covered} / ${store.total} screens (${pct}%)** — 更新: ${store.updatedAt} (source: ${store.source})`, '')

  lines.push(`## 未網羅 (${uncovered.length})`, '')
  for (const e of uncovered) lines.push(`- [ ] ${e.path}`)
  lines.push('')

  lines.push(`## 網羅済み (${covered.length})`, '')
  for (const e of covered) {
    const last = e.lastCoveredAt ? ` (last: ${e.lastCoveredAt})` : ''
    lines.push(`- [x] ${e.path}${last}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Load the persisted screen-coverage store; null when missing, and null (with a warning) when corrupt. */
export async function loadScreenCoverageStore(root: string): Promise<ScreenCoverageStore | null> {
  const path = join(statePaths(root).explore, COVERAGE_JSON)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(text) as ScreenCoverageStore
  } catch (err) {
    logger.warn({ err: String(err), path }, 'screen-coverage: corrupt screen-coverage.json — ignoring')
    return null
  }
}

/** Persist the store as screen-coverage.json (pretty) + screen-coverage.md under the explore state dir. */
export async function saveScreenCoverageStore(root: string, store: ScreenCoverageStore): Promise<void> {
  const dir = statePaths(root).explore
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, COVERAGE_JSON), `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await writeFile(join(dir, COVERAGE_MD), renderScreenCoverageMarkdown(store), 'utf8')
}
