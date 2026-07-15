import { logger } from '../../util/logger.js'
import { waitForClientRender } from './render.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv, RawPage, Grow } from '../../domain/types.js'

/** Assets and non-page resources we never enqueue for discovery. */
const ASSET_EXT = /\.(js|mjs|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|map|pdf|zip|mp4|mp3|json|xml)(\?|#|$)/i

/** Per-page cap on click candidates explored, to bound the extra navigations click discovery adds. */
const MAX_CLICK_CANDIDATES_PER_PAGE = 12

/** Clickable, non-link elements that may drive JS/SPA navigation without an `<a href>`. */
const CLICKABLE_SELECTOR = 'button, [role="button"], [onclick], [data-href]'

/**
 * Labels that signal a side-effecting or destructive action we must NOT click (crawl is
 * read-only; success-path observation only). Matches EN + JA. Kept in sync with the in-page
 * copy inside {@link discoverClickTargets} (page.evaluate can't reference this closure).
 */
const DESTRUCTIVE_LABEL = /logout|sign[\s-]?out|log[\s-]?out|delete|destroy|remove|submit|save|update|削除|ログアウト|サインアウト|送信|保存|更新/i

export function isDestructiveLabel(label: string): boolean {
  return DESTRUCTIVE_LABEL.test(label)
}

/** A clickable candidate discovered in the DOM. `index` maps to a `data-ck-idx` tag on the element. */
export type ClickTarget = { index: number; label: string }

/**
 * A navigation edge discovered during BFS: a page transition the crawl chose to enqueue.
 * `from`/`to` are normalized URLs ({@link normalizeUrl}) so they match across query/fragment
 * variants.
 *
 * `to` is always the URL the browser actually landed on (the `finalUrl` resolved by
 * {@link capture} via `page.url()`), never the pre-visit href — so a link that server-side
 * redirects (`/orders` → `/orders/list`) records its edge against the stored page, not the
 * phantom href. LINK edges therefore fire on successful VISIT (after redirects resolve);
 * CLICK edges fire on enqueue but already use the post-navigation `page.url()`.
 */
export type NavEdge = { from: string; to: string; kind: 'link' | 'click'; label?: string }

/**
 * Authenticated discovery crawl: starting from the post-login root, follow
 * same-origin in-app links breadth-first up to `maxPages`/`maxDepth`, skipping
 * excluded paths, logout, external origins, and asset URLs. Reuses the given
 * (already authenticated) page, navigating it sequentially. Pages that fail to
 * load are skipped (logged), not fatal.
 */
export async function discoverPages(
  page: PageLike,
  target: TargetEnv,
  opts: Grow,
  clickDiscovery = false,
  onEdge?: (edge: NavEdge) => void,
  seedPaths: string[] = [],
): Promise<RawPage[]> {
  const baseUrl = target.baseUrl.replace(/\/$/, '')
  const origin = safeOrigin(baseUrl)
  const startUrl = `${baseUrl}/`

  const visited = new Set<string>()
  const results: RawPage[] = []
  // `edge` carries the intended link edge context (the parent that contained the link). The edge is
  // fired only after this item is visited, so `to` can be the post-redirect finalUrl, not the href.
  // Seed/root item has no parent → no edge. Click transitions push edge-less items (they fire on
  // enqueue against the post-navigation URL themselves).
  type QueueItem = { url: string; depth: number; edge?: { from: string; label?: string } }
  const queue: QueueItem[] = [{ url: startUrl, depth: 0 }]

  // Seed screens (from the static inventory) are enqueued at depth 0 alongside the root so they are
  // visited even when nothing in the app links to them — the coverage denominator must be reachable.
  // They obey the same origin/asset/logout/exclude gates as discovered links; the per-item `visited`
  // guard dedupes them against the root and each other. Edge-less (they have no linking parent).
  for (const seed of seedPaths) {
    const abs = resolveSeedUrl(seed, baseUrl)
    if (!abs) continue
    if (safeOrigin(abs) !== origin) continue
    if (isAsset(abs) || isLogout(abs) || isExcluded(abs, opts.excludePaths)) continue
    queue.push({ url: abs, depth: 0 })
  }

  while (queue.length > 0 && results.length < opts.maxPages) {
    const { url, depth, edge } = queue.shift() as QueueItem
    const key = normalizeUrl(url)
    if (visited.has(key)) continue
    visited.add(key)

    let raw: RawPage
    try {
      raw = await capture(page, url)
    } catch (err) {
      logger.warn({ url, err: String(err instanceof Error ? err.message : err) }, 'discover: page load failed, skipping')
      continue
    }
    results.push(raw)
    // Record the link edge now that `raw.url` is the real landing URL (redirects resolved), so the
    // edge target matches the page stored in `structure.pages` rather than the pre-visit href.
    if (edge) {
      onEdge?.({ from: edge.from, to: normalizeUrl(raw.url), kind: 'link', ...(edge.label ? { label: edge.label } : {}) })
    }
    if (results.length >= opts.maxPages) break
    if (depth >= opts.maxDepth) continue

    for (const link of extractLinks(raw.html, baseUrl)) {
      if (safeOrigin(link) !== origin) continue
      if (isAsset(link)) continue
      if (isLogout(link)) continue
      if (isExcluded(link, opts.excludePaths)) continue
      const linkKey = normalizeUrl(link)
      if (visited.has(linkKey)) continue
      queue.push({ url: link, depth: depth + 1, edge: { from: key } })
    }

    // Button/JS-driven navigation: `<a href>` alone misses SPA/onclick transitions. Click each
    // (non-destructive) candidate on a freshly re-rendered copy of this page; if the URL changes to
    // a new same-origin page, enqueue it — otherwise it was a modal/toggle and is left alone.
    if (clickDiscovery) {
      await enqueueClickTransitions(page, url, origin, opts, depth, visited, queue, onEdge)
    }
  }

  if (results.length >= opts.maxPages) {
    logger.info({ maxPages: opts.maxPages }, 'discover: reached maxPages limit')
  }
  logger.info({ discovered: results.length }, 'discover: crawl complete')
  return results
}

/**
 * Enumerate clickable, non-link, non-destructive candidates in the current DOM and tag each with a
 * `data-ck-idx` attribute so the caller can re-select it by index. Destructive/side-effecting
 * candidates (delete/submit/logout…), form-submit buttons, real links, and unlabeled icon buttons
 * (unknown intent) are excluded in-page. Returns [] on any evaluate failure.
 */
export async function discoverClickTargets(page: PageLike): Promise<ClickTarget[]> {
  const ep = page as unknown as {
    evaluate: <T>(fn: (selector: string) => T, selector: string) => Promise<T>
  }
  try {
    const result = await ep.evaluate((selector) => {
      // NOTE: this runs in the page; it cannot reference module-level constants (DESTRUCTIVE_LABEL).
      const DESTRUCTIVE = /logout|sign[\s-]?out|log[\s-]?out|delete|destroy|remove|submit|save|update|削除|ログアウト|サインアウト|送信|保存|更新/i
      const isVisible = (el: Element): boolean => {
        const h = el as HTMLElement
        return !!(h.offsetWidth || h.offsetHeight || el.getClientRects().length)
      }
      const els = Array.from(document.querySelectorAll(selector))
      const out: Array<{ index: number; label: string }> = []
      els.forEach((el, i) => {
        if (!isVisible(el)) return
        if (el.closest('a[href]')) return // real links are handled by <a href> extraction
        const tag = el.tagName.toLowerCase()
        const type = (el.getAttribute('type') || '').toLowerCase()
        if (tag === 'button' && type === 'submit') return // form submit → side effect
        if (el.closest('form')) return // anything inside a form may mutate on click
        const label = (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        const dataHref = el.getAttribute('data-href') || ''
        if (DESTRUCTIVE.test(label)) return
        if (!label && !dataHref) return // unlabeled icon button of unknown intent → skip for safety
        el.setAttribute('data-ck-idx', String(i))
        out.push({ index: i, label })
      })
      return out
    }, CLICKABLE_SELECTOR)
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

/**
 * For each click candidate on `pageUrl`: restore the page (so the DOM/tags are fresh), click the
 * candidate, and if it navigates to a new same-origin, non-excluded page, enqueue that page. Bounded
 * by {@link MAX_CLICK_CANDIDATES_PER_PAGE}. Best-effort: any per-candidate error is skipped, not fatal.
 */
async function enqueueClickTransitions(
  page: PageLike,
  pageUrl: string,
  origin: string,
  opts: Grow,
  depth: number,
  visited: Set<string>,
  queue: Array<{ url: string; depth: number }>,
  onEdge?: (edge: NavEdge) => void,
): Promise<void> {
  const candidates = (await discoverClickTargets(page))
    .filter((t) => !isDestructiveLabel(t.label))
    .slice(0, MAX_CLICK_CANDIDATES_PER_PAGE)

  for (const candidate of candidates) {
    // Re-render this page and re-tag so the selector resolves against a clean DOM (a prior click may
    // have navigated away or mutated the DOM).
    let reTagged: ClickTarget[]
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle')
      reTagged = await discoverClickTargets(page)
    } catch (err) {
      logger.warn({ pageUrl, err: String(err instanceof Error ? err.message : err) }, 'discover: click reset failed, stopping clicks')
      break
    }
    if (!reTagged.some((r) => r.index === candidate.index)) continue

    let after: string
    try {
      await page.locator(`[data-ck-idx="${candidate.index}"]`).click()
      await page.waitForLoadState('networkidle')
      after = page.url()
    } catch {
      continue // click failed / element detached — skip
    }

    const key = normalizeUrl(after)
    if (key === normalizeUrl(pageUrl)) continue // modal/toggle, not a navigation
    if (safeOrigin(after) !== origin) continue
    if (isAsset(after) || isLogout(after) || isExcluded(after, opts.excludePaths)) continue
    if (visited.has(key)) continue
    if (queue.some((q) => normalizeUrl(q.url) === key)) continue
    queue.push({ url: after, depth: depth + 1 })
    onEdge?.({ from: normalizeUrl(pageUrl), to: key, kind: 'click', label: candidate.label })
    logger.info({ from: pageUrl, to: after, label: candidate.label }, 'discover: click transition enqueued')
  }
}

async function capture(page: PageLike, url: string): Promise<RawPage> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle')
  // Same rationale as crawler.ts capturePage: don't capture the pre-hydration CSR shell.
  await waitForClientRender(page)
  const finalUrl = page.url()
  const title = await page.title()
  const html = await page.content()
  // Discovery captures structure for coverage/proposal; meta is not needed here.
  return { url: finalUrl, title, html, meta: {}, screenshotPath: '' }
}

/** Extract absolute, same-document `<a href>` links resolved against baseUrl. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = []
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim()
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
    try {
      links.push(new URL(href, `${baseUrl}/`).toString())
    } catch {
      // ignore unparseable hrefs
    }
  }
  return links
}

/** Resolve a seed screen (a concrete path like `/hotel/123`, or an absolute URL) against baseUrl. */
function resolveSeedUrl(seed: string, baseUrl: string): string | null {
  try {
    return new URL(seed, `${baseUrl}/`).toString()
  } catch {
    return null
  }
}

/** Normalize to origin+pathname (no query, no fragment, no trailing slash) for dedup. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '') || '/'
    return `${u.origin}${path}`
  } catch {
    return url
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function isAsset(url: string): boolean {
  return ASSET_EXT.test(url)
}

function isLogout(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase()
    return p.includes('logout') || p.includes('sign-out') || p.includes('signout')
  } catch {
    return false
  }
}

function isExcluded(url: string, excludePaths: string[]): boolean {
  if (excludePaths.length === 0) return false
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url
  }
  return excludePaths.some((ex) => pathname.includes(ex))
}
