import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { logger } from '../../util/logger.js'

export type BrowserCtx = {
  browser: Browser
}

/**
 * Launches a headless Chromium instance. Pages and contexts are created with
 * `ignoreHTTPSErrors` so crawl-kit can target local/dev apps served over
 * self-signed HTTPS (e.g. Laravel/Docker dev stacks) — a plain browser.newPage()
 * would otherwise fail navigation with ERR_CERT_AUTHORITY_INVALID.
 */
export async function launchBrowser(): Promise<BrowserCtx> {
  logger.debug('Launching chromium browser')
  // Optional host→IP mapping for local vhost targets not in /etc/hosts
  // (e.g. CRAWLKIT_HOST_RESOLVER_RULES="MAP testing.roomport.jp 127.0.0.1").
  const resolverRules = process.env.CRAWLKIT_HOST_RESOLVER_RULES
  const args = resolverRules ? [`--host-resolver-rules=${resolverRules}`] : []
  const browser = await chromium.launch({ headless: true, args })
  // Wrap so every newPage()/newContext() call (callers pass no args) ignores TLS errors.
  const wrapped = {
    newPage: (opts?: Parameters<Browser['newPage']>[0]) => browser.newPage({ ignoreHTTPSErrors: true, ...opts }),
    newContext: (opts?: Parameters<Browser['newContext']>[0]) => browser.newContext({ ignoreHTTPSErrors: true, ...opts }),
    close: () => browser.close(),
  }
  return { browser: wrapped as unknown as Browser }
}
