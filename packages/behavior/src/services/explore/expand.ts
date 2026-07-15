import { logger } from '../../util/logger.js'
import { extractLinks } from '../browser/discover.js'
import { waitForClientRender } from '../browser/render.js'
import { sameOrigin } from '../browser/recorder.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv } from '../../domain/types.js'

/**
 * Normalize a screen-prefix to an absolute pathname: an absolute URL keeps only its pathname
 * (`https://app.test/orders` becomes `/orders` — mirroring discoverForms, which also accepts
 * absolute screen entries), a bare `orders` gains its leading slash (config-schema-valid without
 * one), and any trailing slash is stripped (`/orders/` becomes `/orders`), so the same prefix
 * used to build the goto-path and the one used to match links always agree. `/` collapses to itself.
 */
function normalizePrefix(prefix: string): string {
  const path = /^https?:\/\//i.test(prefix) ? new URL(prefix).pathname : prefix
  return (`/${path.replace(/^\/+/, '')}`).replace(/\/+$/, '') || '/'
}

/**
 * Pure core: find same-origin links in `html` whose pathname falls under `prefix` — the prefix
 * itself, or one of its path segments (`/orders` matches `/orders` and `/orders/123/edit`, but not
 * `/orders-archive`). Returned as pathname+search (query kept, fragment dropped — `extractLinks`
 * never captures fragments in the first place), deduped, in first-occurrence order.
 */
export function matchPrefixLinks(html: string, baseUrl: string, prefix: string): string[] {
  const normalizedPrefix = normalizePrefix(prefix)
  const seen = new Set<string>()
  const matches: string[] = []
  for (const link of extractLinks(html, baseUrl)) {
    if (!sameOrigin(link, baseUrl)) continue
    let u: URL
    try {
      u = new URL(link)
    } catch {
      continue
    }
    // `/` is intentionally NOT treated as "expand entire site": it only matches links whose
    // pathname is exactly `/` (nothing starts with `//`), so a root prefix degenerates to
    // matching just itself. Whole-site expansion is the crawler's job, not screen-prefix's.
    if (u.pathname !== normalizedPrefix && !u.pathname.startsWith(`${normalizedPrefix}/`)) continue
    const screenPath = `${u.pathname}${u.search}`
    if (seen.has(screenPath)) continue
    seen.add(screenPath)
    matches.push(screenPath)
  }
  return matches
}

/**
 * Depth-1 expansion of listing screens: for each prefix, load the page and collect same-prefix
 * links from it (via {@link matchPrefixLinks}), so explore can be given `/orders` and also cover
 * `/orders/new`, `/orders/123/edit`, etc. The prefix path itself is always included, before its
 * matches. A prefix that fails to load is tolerated (logged, mirroring discoverForms) — the run
 * still gets that prefix's own path. Results are deduped across all prefixes.
 */
export async function expandScreenPrefixes(page: PageLike, target: TargetEnv, prefixes: string[]): Promise<string[]> {
  const base = target.baseUrl.replace(/\/$/, '')
  const seen = new Set<string>()
  const result: string[] = []
  const add = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    result.push(path)
  }

  for (const prefix of prefixes) {
    const normalizedPrefix = normalizePrefix(prefix)
    add(normalizedPrefix)
    const url = /^https?:\/\//i.test(prefix) ? prefix : `${base}${normalizedPrefix}`
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle')
      // CSR SPAs can pass networkidle before hydration renders any links — wait for the DOM
      // to settle or the listing expands to nothing (same failure mode as crawl discovery).
      await waitForClientRender(page)
      for (const match of matchPrefixLinks(await page.content(), base, prefix)) add(match)
    } catch (err) {
      logger.warn({ err: String(err), prefix }, 'explore expand: failed to load screen-prefix page — using prefix only')
    }
  }
  return result
}
