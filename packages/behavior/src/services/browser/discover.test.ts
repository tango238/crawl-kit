import { describe, it, expect, vi } from 'vitest'
import { discoverPages, isDestructiveLabel, normalizeUrl, type ClickTarget, type NavEdge } from './discover.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv, Grow } from '../../domain/types.js'

const target: TargetEnv = { name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form' } }
const grow: Grow = { maxPages: 50, maxDepth: 3, excludePaths: [] }

/**
 * Fake page whose content() returns the HTML registered for the current URL.
 * goto() sets the current URL; pages return links via `<a href>`.
 */
function makePage(pages: Record<string, string>, failPaths: string[] = []): PageLike {
  let url = ''
  return {
    goto: vi.fn(async (u: string) => {
      const path = new URL(u).pathname.replace(/\/+$/, '') || '/'
      if (failPaths.includes(path)) throw new Error('load failed')
      url = u
    }),
    url: vi.fn(() => url),
    title: vi.fn(async () => `title:${url}`),
    content: vi.fn(async () => {
      // match by normalized path
      const path = new URL(url).pathname.replace(/\/+$/, '') || '/'
      return pages[path] ?? '<html></html>'
    }),
    evaluate: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    locator: vi.fn(() => ({ fill: vi.fn(async () => {}), click: vi.fn(async () => {}) })),
  } as unknown as PageLike
}

const link = (href: string) => `<a href="${href}">x</a>`

describe('discoverPages', () => {
  it('BFS-discovers same-origin in-app pages from the root', async () => {
    const page = makePage({
      '/': link('/hotel') + link('/booking'),
      '/hotel': link('/hotel/create'),
      '/booking': '',
      '/hotel/create': '',
    })
    const pages = await discoverPages(page, target, grow)
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/')
    expect(paths).toContain('/hotel')
    expect(paths).toContain('/booking')
    expect(paths).toContain('/hotel/create')
  })

  it('respects maxPages', async () => {
    const page = makePage({
      '/': link('/a') + link('/b') + link('/c') + link('/d'),
      '/a': '', '/b': '', '/c': '', '/d': '',
    })
    const pages = await discoverPages(page, target, { maxPages: 2, maxDepth: 3, excludePaths: [] })
    expect(pages.length).toBe(2)
  })

  it('respects maxDepth (does not follow links beyond depth)', async () => {
    const page = makePage({
      '/': link('/deep1'),
      '/deep1': link('/deep2'),
      '/deep2': link('/deep3'),
      '/deep3': '',
    })
    const pages = await discoverPages(page, target, { maxPages: 50, maxDepth: 1, excludePaths: [] })
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/')
    expect(paths).toContain('/deep1') // depth 1 captured
    expect(paths).not.toContain('/deep2') // depth 2 not followed (maxDepth=1)
  })

  it('excludes external origins, logout, assets, and excludePaths', async () => {
    const page = makePage({
      '/': link('https://evil.example.com/x') + link('/logout') + link('/app.js') + link('/admin') + link('/secret'),
      '/admin': '',
      '/secret': '',
    })
    const pages = await discoverPages(page, target, { maxPages: 50, maxDepth: 3, excludePaths: ['/secret'] })
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/admin')
    expect(paths).not.toContain('/logout')
    expect(paths).not.toContain('/secret')
    expect(paths.some((p) => p.includes('evil'))).toBe(false)
    expect(paths.some((p) => p.endsWith('.js'))).toBe(false)
  })

  it('dedups repeated links and skips pages that fail to load', async () => {
    const page = makePage(
      {
        '/': link('/x') + link('/x') + link('/y'),
        '/x': link('/'), // back-link to root (already visited)
        '/y': '',
      },
      ['/y'], // /y fails to load
    )
    const pages = await discoverPages(page, target, grow)
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    // /x appears once (dedup), /y skipped (load failure), no crash
    expect(paths.filter((p) => p === '/x').length).toBe(1)
    expect(paths).not.toContain('/y')
  })
})

describe('discoverPages — CSR shell settles before capture', () => {
  it('waits out a late-hydrating root page so its links still feed BFS', async () => {
    // The root serves the pre-hydration empty shell for the first content() samples, then the
    // hydrated DOM — mirroring a Next.js page that passes networkidle before client render.
    // Pre-fix, the shell (zero links) was captured and discovery stopped at depth 0.
    let serves = 0
    let url = ''
    const shell = '<html><head><title>app</title></head><body><div id="__next"></div></body></html>'
    const page = {
      goto: vi.fn(async (u: string) => { url = u; serves = 0 }),
      url: vi.fn(() => url),
      title: vi.fn(async () => 'app'),
      content: vi.fn(async () => {
        const path = new URL(url).pathname.replace(/\/+$/, '') || '/'
        if (path !== '/') return link('/hotel')
        serves += 1
        return serves < 3 ? shell : `<html><body>${link('/hotel')}</body></html>`
      }),
      evaluate: vi.fn(async () => ({})),
      screenshot: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      locator: vi.fn(() => ({ fill: vi.fn(async () => {}), click: vi.fn(async () => {}) })),
    } as unknown as PageLike
    const pages = await discoverPages(page, target, grow)
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/hotel')
  })
})

describe('isDestructiveLabel', () => {
  it('flags destructive / side-effecting labels (EN + JA)', () => {
    for (const l of ['Logout', 'Sign out', 'Delete', 'Remove item', 'Submit', 'Save', 'Update', '削除', 'ログアウト', '送信', '保存']) {
      expect(isDestructiveLabel(l)).toBe(true)
    }
  })
  it('allows read-only / navigational labels', () => {
    for (const l of ['Details', 'View', 'Open panel', '一覧', '詳細', 'Next']) {
      expect(isDestructiveLabel(l)).toBe(false)
    }
  })
})

/**
 * Fake page for click-driven discovery. `candidates[path]` is what discoverClickTargets returns for
 * the current page; `clicks[path][index]` is the URL a click navigates to (absent → no navigation).
 */
function makeClickPage(cfg: {
  candidates: Record<string, ClickTarget[]>
  clicks: Record<string, Record<number, string>>
}): PageLike {
  let url = ''
  const pathOf = (u: string) => new URL(u).pathname.replace(/\/+$/, '') || '/'
  return {
    goto: vi.fn(async (u: string) => { url = u }),
    url: vi.fn(() => url),
    title: vi.fn(async () => `title:${url}`),
    content: vi.fn(async () => '<html></html>'), // no <a href>; navigation is click-only
    // discoverClickTargets calls evaluate(fn, selector); ignore fn, return canned candidates.
    evaluate: vi.fn(async () => cfg.candidates[pathOf(url)] ?? []),
    screenshot: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    locator: vi.fn((selector: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        const m = /data-ck-idx="(\d+)"/.exec(selector)
        if (!m) return
        const idx = Number(m[1])
        const dest = cfg.clicks[pathOf(url)]?.[idx]
        if (dest) url = dest // simulate navigation
      }),
    })),
  } as unknown as PageLike
}

describe('discoverPages — click-driven transitions (Fix 3)', () => {
  it('enqueues pages reached by clicking non-link buttons', async () => {
    const page = makeClickPage({
      candidates: { '/': [{ index: 0, label: 'Open panel' }, { index: 1, label: 'Toggle' }] },
      clicks: { '/': { 0: 'http://localhost:3000/panel' } }, // index 1 does not navigate
    })
    const pages = await discoverPages(page, target, grow, true)
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/')
    expect(paths).toContain('/panel') // reached only via click
  })

  it('does not click destructive candidates even if returned', async () => {
    const page = makeClickPage({
      candidates: { '/': [{ index: 0, label: 'Delete' }] },
      clicks: { '/': { 0: 'http://localhost:3000/deleted' } },
    })
    const pages = await discoverPages(page, target, grow, true)
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).not.toContain('/deleted')
  })

  it('is disabled by default (no click discovery unless requested)', async () => {
    const page = makeClickPage({
      candidates: { '/': [{ index: 0, label: 'Open panel' }] },
      clicks: { '/': { 0: 'http://localhost:3000/panel' } },
    })
    const pages = await discoverPages(page, target, grow) // clickDiscovery defaults to false
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).not.toContain('/panel')
  })
})

describe('discoverPages — onEdge navigation-edge recording', () => {
  it('reports a link edge (from/to/kind) on enqueue for a 2-page crawl', async () => {
    const page = makePage({
      '/': link('/about'),
      '/about': '',
    })
    const edges: NavEdge[] = []
    const pages = await discoverPages(page, target, grow, false, (e) => edges.push(e))

    expect(pages.length).toBe(2)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toEqual({
      from: normalizeUrl('http://localhost:3000/'),
      to: normalizeUrl('http://localhost:3000/about'),
      kind: 'link',
    })
  })

  it('reports a click edge (kind:"click", label set) when a click transition is discovered', async () => {
    const page = makeClickPage({
      candidates: { '/': [{ index: 0, label: 'Open panel' }] },
      clicks: { '/': { 0: 'http://localhost:3000/panel' } },
    })
    const edges: NavEdge[] = []
    await discoverPages(page, target, grow, true, (e) => edges.push(e))

    expect(edges).toContainEqual({
      from: normalizeUrl('http://localhost:3000/'),
      to: normalizeUrl('http://localhost:3000/panel'),
      kind: 'click',
      label: 'Open panel',
    })
  })

  it('records the link edge target from the post-redirect finalUrl, not the raw href', async () => {
    // `/orders` 302-redirects to `/orders/list`: goto('/orders') lands on page.url()==='/orders/list'.
    const redirects: Record<string, string> = { '/orders': 'http://localhost:3000/orders/list' }
    const contents: Record<string, string> = { '/': link('/orders'), '/orders/list': '' }
    let url = ''
    const page = {
      goto: vi.fn(async (u: string) => {
        const path = new URL(u).pathname.replace(/\/+$/, '') || '/'
        url = redirects[path] ?? u
      }),
      url: vi.fn(() => url),
      title: vi.fn(async () => `title:${url}`),
      content: vi.fn(async () => {
        const path = new URL(url).pathname.replace(/\/+$/, '') || '/'
        return contents[path] ?? '<html></html>'
      }),
      evaluate: vi.fn(async () => []),
      screenshot: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      locator: vi.fn(() => ({ fill: vi.fn(async () => {}), click: vi.fn(async () => {}) })),
    } as unknown as PageLike

    const edges: NavEdge[] = []
    const pages = await discoverPages(page, target, grow, false, (e) => edges.push(e))

    const linkEdges = edges.filter((e) => e.kind === 'link')
    expect(linkEdges).toHaveLength(1)
    // Edge target must be where the browser actually landed (the stored page), not the raw href.
    expect(linkEdges[0]?.to).toBe(normalizeUrl('http://localhost:3000/orders/list'))
    expect(linkEdges[0]?.to).not.toBe(normalizeUrl('http://localhost:3000/orders'))
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/orders/list')
  })

  it('does not emit edges for links that are filtered out (asset/logout/excluded/external)', async () => {
    const page = makePage({
      '/': link('https://evil.example.com/x') + link('/logout') + link('/app.js') + link('/secret'),
    })
    const edges: NavEdge[] = []
    await discoverPages(page, target, { maxPages: 50, maxDepth: 3, excludePaths: ['/secret'] }, false, (e) => edges.push(e))
    expect(edges).toHaveLength(0)
  })

  it('behaves exactly as before when onEdge is omitted (backward compatible)', async () => {
    const page = makePage({
      '/': link('/about'),
      '/about': '',
    })
    // No onEdge arg passed — must not throw and must return the same pages as always.
    const pages = await discoverPages(page, target, grow)
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/')
    expect(paths).toContain('/about')
  })
})
