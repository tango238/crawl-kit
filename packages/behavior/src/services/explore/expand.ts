import { logger } from '../../util/logger.js'
import { extractLinks } from '../browser/discover.js'
import { sameOrigin } from '../browser/recorder.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv } from '../../domain/types.js'

/**
 * Pure core: find same-origin links in `html` whose pathname falls under `prefix` — the prefix
 * itself, or one of its path segments (`/orders` matches `/orders` and `/orders/123/edit`, but not
 * `/orders-archive`). Returned as pathname+search (query kept, fragment dropped — `extractLinks`
 * never captures fragments in the first place), deduped, in first-occurrence order.
 */
export function matchPrefixLinks(html: string, baseUrl: string, prefix: string): string[] {
  const normalizedPrefix = prefix.replace(/\/+$/, '') || '/'
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
    add(prefix)
    const url = /^https?:\/\//i.test(prefix) ? prefix : `${base}/${prefix.replace(/^\//, '')}`
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle')
      for (const match of matchPrefixLinks(await page.content(), base, prefix)) add(match)
    } catch (err) {
      logger.warn({ err: String(err), prefix }, 'explore expand: failed to load screen-prefix page — using prefix only')
    }
  }
  return result
}
