import { ensureDir } from '../../util/fs.js'
import { logger } from '../../util/logger.js'
import { screenshot } from './snapshot.js'
import { discoverPages, normalizeUrl } from './discover.js'
import { waitForClientRender, settleNetwork } from './render.js'
import type { NavEdge } from './discover.js'
import type { RawPage, TargetEnv } from '../../domain/types.js'
import type { Crawl } from '../../config/schema.js'
import { allSteps, type Scenario } from '../../scenario/schema.js'

// Minimal shape used from Playwright's Browser/Page to keep the module unit-testable
export type PageLike = {
  goto: (url: string, opts?: { waitUntil?: 'commit' | 'domcontentloaded' | 'networkidle' | 'load'; timeout?: number }) => Promise<unknown>
  url: () => string
  title: () => Promise<string>
  content: () => Promise<string>
  evaluate: (fn: () => Record<string, string>) => Promise<Record<string, string>>
  screenshot: (opts: { path: string; fullPage: boolean }) => Promise<unknown>
  waitForLoadState: (state?: 'domcontentloaded' | 'networkidle' | 'load') => Promise<void>
  locator: (selector: string) => {
    fill: (value: string) => Promise<void>
    click: () => Promise<void>
    count?: () => Promise<number>
    textContent?: () => Promise<string | null>
    inputValue?: () => Promise<string>
  }
  /** Optional: close the page after capture to release resources */
  close?: () => Promise<void>
}

export type BrowserLike = {
  newPage: () => Promise<PageLike>
  close: () => Promise<void>
}

/**
 * Performs form-based authentication on the given page.
 */
async function performFormLogin(
  page: PageLike,
  baseUrl: string,
  auth: NonNullable<TargetEnv['auth']>,
): Promise<void> {
  if (!auth.loginPath) {
    logger.warn('form auth configured but no loginPath specified — skipping login')
    return
  }
  const loginUrl = `${baseUrl}${auth.loginPath}`
  logger.debug({ loginUrl }, 'Navigating to login page')
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle')

  if (auth.username) {
    const usernameLocator = page.locator('[name="username"],[name="email"],[type="email"],[name="user"]')
    await usernameLocator.fill(auth.username)
  }
  if (auth.password) {
    const passwordLocator = page.locator('[name="password"],[type="password"]')
    await passwordLocator.fill(auth.password)
  }
  const submitLocator = page.locator('[type="submit"],button[type="submit"]')
  await submitLocator.click()
  await page.waitForLoadState('networkidle')
}

/**
 * Collects meta tags from the page via evaluate.
 */
function buildMetaCollector(): () => Record<string, string> {
  return () => {
    const metas: Record<string, string> = {}
    document.querySelectorAll('meta[name]').forEach((el) => {
      const name = el.getAttribute('name')
      const content = el.getAttribute('content')
      if (name && content) metas[name] = content
    })
    return metas
  }
}

/** Returns true if the step target looks like a navigable URL path or absolute URL */
function isNavigationTarget(t: string): boolean {
  return t.startsWith('/') || t.startsWith('http://') || t.startsWith('https://')
}

/** Resolves a step target to an absolute URL */
function resolveUrl(stepTarget: string, baseUrl: string): string {
  if (stepTarget.startsWith('http://') || stepTarget.startsWith('https://')) {
    return stepTarget
  }
  return `${baseUrl.replace(/\/$/, '')}${stepTarget}`
}

/**
 * Captures a single page at the given URL: navigates, waits, collects metadata, takes screenshot.
 */
async function capturePage(page: PageLike, url: string, screenshotDir: string): Promise<RawPage> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // Bounded: pages with polling/websocket traffic may never reach Playwright's networkidle.
  await settleNetwork(page, 10_000)
  // CSR SPAs can pass networkidle before hydration renders anything — without this wait the
  // captured HTML is an empty shell (zero links) and BFS starves at depth 0.
  await waitForClientRender(page)

  const finalUrl = page.url()
  const title = await page.title()
  const html = await page.content()
  let meta: Record<string, string> = {}
  try {
    meta = await page.evaluate(buildMetaCollector())
  } catch {
    // evaluate may not work in all test environments; default to empty
  }

  const screenshotFilename = `${slugify(finalUrl)}.png`
  let screenshotPath = ''
  try {
    screenshotPath = await screenshot(page, screenshotDir, screenshotFilename)
  } catch {
    screenshotPath = `${screenshotDir}/${screenshotFilename}`
  }

  logger.debug({ url: finalUrl, title }, 'Crawled page')
  return { url: finalUrl, title, html, meta, screenshotPath }
}

/**
 * Core crawl function that accepts an injectable browser-like object.
 * This design allows unit tests to pass a fake browser with no real Playwright.
 *
 * Crawls the base URL first, then follows navigation targets from scenario steps
 * to build a multi-page RawPage array. Deduplicates by URL.
 */
export type CrawlOpts = {
  /**
   * Scenario-aware login hook. When provided, it authenticates the crawl page INSTEAD of the
   * built-in generic `performFormLogin` — letting callers reuse the full login flow (2FA, custom
   * selectors) so the crawl observes authenticated state in environments generic login can't reach.
   * It must throw on failure (the caller then decides how to degrade).
   */
  authenticate?: (page: PageLike, target: TargetEnv) => Promise<void>
  /**
   * Skip login entirely. Use when the page comes from a browser context that is ALREADY
   * authenticated (e.g. a shared session established once and reused across stages) — the crawl
   * just navigates with the existing cookies. Takes precedence over `authenticate`/form login.
   */
  skipLogin?: boolean
  /**
   * When set, after capturing base + scenario targets, run BFS link discovery on the SAME
   * (already authenticated) page and merge newly-reached same-origin pages, up to `maxPages` total.
   * This lifts the crawl beyond base + scenario transitions (the cause of pageCount=2) so the
   * viewer's observation map covers more of the app.
   */
  discover?: Crawl
  /**
   * Fired for every navigation edge (link/click) the BFS discovery stage enqueues — lets callers
   * (the collect pipeline) record the site's navigation graph alongside the visited pages. Only
   * takes effect when `discover` is set, since BFS discovery is what produces edges.
   */
  onEdge?: (edge: NavEdge) => void
  /**
   * Concrete screen paths (from the static screen inventory) to guarantee the crawl visits, even
   * when nothing in the app links to them — so the screen-coverage denominator is reachable. Only
   * takes effect when `discover` is set (they are enqueued into BFS at depth 0). Templated paths
   * (containing `:`) are dropped here: only concrete paths can be navigated to.
   */
  seedPaths?: string[]
}

export async function crawlWithBrowser(
  browser: BrowserLike,
  target: TargetEnv,
  scenarios: Scenario[],
  screenshotDir: string,
  opts: CrawlOpts = {},
): Promise<RawPage[]> {
  await ensureDir(screenshotDir)

  const visitedUrls = new Set<string>()
  const rawPages: RawPage[] = []

  const page = await browser.newPage()

  try {
    // Authenticate if needed. `skipLogin` (page from an already-authenticated shared context) wins;
    // otherwise a scenario-aware hook (2FA/custom selectors) takes precedence over generic form login.
    if (opts.skipLogin) {
      logger.debug('crawl: skipLogin set — reusing the already-authenticated session')
    } else if (opts.authenticate) {
      await opts.authenticate(page, target)
    } else if (target.auth?.strategy === 'form') {
      await performFormLogin(page, target.baseUrl, target.auth)
    }

    // Always capture the base URL first
    const basePage = await capturePage(page, target.baseUrl, screenshotDir)
    visitedUrls.add(basePage.url)
    rawPages.push(basePage)

    // Follow scenario step navigation targets to build multi-page crawl
    for (const scenario of scenarios) {
      for (const step of allSteps(scenario)) {
        if (!isNavigationTarget(step.target)) continue

        const targetUrl = resolveUrl(step.target, target.baseUrl)
        if (visitedUrls.has(targetUrl)) continue

        try {
          const stepPage = await capturePage(page, targetUrl, screenshotDir)
          visitedUrls.add(targetUrl)
          rawPages.push(stepPage)
          logger.debug(
            { from: rawPages[rawPages.length - 2]?.url, to: stepPage.url, trigger: step.action },
            'Followed scenario transition',
          )
        } catch (err) {
          logger.warn(
            { err, targetUrl, scenario: scenario.id },
            'Failed to navigate to scenario step target — skipping',
          )
        }
      }
    }

    // BFS discovery on the same authenticated page: follow same-origin links beyond base+scenario
    // so the crawl reaches more pages. Merge deduped, capped at discover.maxPages total.
    if (opts.discover) {
      const scenarioPageCount = rawPages.length
      // Only concrete paths can be navigated to — a templated `/hotel/:id` is not a real URL.
      const seedPaths = (opts.seedPaths ?? []).filter((p) => !p.includes(':'))
      const discovered = await discoverPages(
        page,
        target,
        opts.discover,
        opts.discover.clickDiscovery ?? true,
        opts.onEdge,
        seedPaths,
      )
      const seen = new Set(rawPages.map((p) => normalizeUrl(p.url)))
      for (const d of discovered) {
        if (rawPages.length >= opts.discover.maxPages) break
        const key = normalizeUrl(d.url)
        if (seen.has(key)) continue
        seen.add(key)
        rawPages.push(d)
      }
      logger.info(
        { baseAndScenario: scenarioPageCount, discovered: discovered.length, total: rawPages.length },
        'crawl: merged BFS discovery pages',
      )
    }
  } finally {
    // Close page to release browser resources
    await page.close?.().catch(() => {})
  }

  return rawPages
}

/**
 * Public API: crawl using a real Playwright browser instance.
 */
export async function crawl(
  browser: BrowserLike,
  target: TargetEnv,
  scenarios: Scenario[],
  screenshotDir: string,
  opts: CrawlOpts = {},
): Promise<RawPage[]> {
  return crawlWithBrowser(browser, target, scenarios, screenshotDir, opts)
}

function slugify(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80)
}
