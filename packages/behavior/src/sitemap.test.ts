import { describe, expect, it } from 'vitest'
import { buildSitemap } from './sitemap.js'
import type { NavEdge } from './services/browser/discover.js'

const NOW = '2026-07-03T00:00:00.000Z'

describe('buildSitemap', () => {
  it('straight chain A→B→C: builds a single linear branch', () => {
    const edges: NavEdge[] = [
      { from: 'https://x/a', to: 'https://x/b', kind: 'link' },
      { from: 'https://x/b', to: 'https://x/c', kind: 'link' },
    ]
    const pages = ['https://x/a', 'https://x/b', 'https://x/c']

    const sitemap = buildSitemap(edges, pages, { now: NOW })

    expect(sitemap.generatedAt).toBe(NOW)
    expect(sitemap.orphans).toEqual([])
    expect(sitemap.roots).toHaveLength(1)
    expect(sitemap.roots[0]).toEqual({
      url: 'https://x/a',
      children: [
        {
          url: 'https://x/b',
          via: { kind: 'link' },
          children: [
            { url: 'https://x/c', via: { kind: 'link' }, children: [] },
          ],
        },
      ],
    })
  })

  it('branching: one parent, two children', () => {
    const edges: NavEdge[] = [
      { from: 'https://x/a', to: 'https://x/b', kind: 'link' },
      { from: 'https://x/a', to: 'https://x/c', kind: 'click', label: 'go' },
    ]
    const pages = ['https://x/a', 'https://x/b', 'https://x/c']

    const sitemap = buildSitemap(edges, pages, { now: NOW })

    expect(sitemap.roots).toHaveLength(1)
    const root = sitemap.roots[0]
    expect(root.url).toBe('https://x/a')
    expect(root.children).toHaveLength(2)
    expect(root.children).toEqual(
      expect.arrayContaining([
        { url: 'https://x/b', via: { kind: 'link' }, children: [] },
        { url: 'https://x/c', via: { kind: 'click', label: 'go' }, children: [] },
      ]),
    )
    expect(sitemap.orphans).toEqual([])
  })

  it('multi-parent: first edge (array order) to a node wins, the other is ignored', () => {
    const edges: NavEdge[] = [
      { from: 'https://x/a', to: 'https://x/c', kind: 'link' },
      { from: 'https://x/b', to: 'https://x/c', kind: 'click', label: 'later' },
    ]
    const pages = ['https://x/a', 'https://x/b', 'https://x/c']

    const sitemap = buildSitemap(edges, pages, { now: NOW })

    // Both a and b are parentless (never a `to`) so both root their own subtree.
    expect(sitemap.roots.map((r) => r.url)).toEqual(['https://x/a', 'https://x/b'])
    const rootA = sitemap.roots.find((r) => r.url === 'https://x/a')!
    const rootB = sitemap.roots.find((r) => r.url === 'https://x/b')!
    // c attached under a (first edge wins) — the b→c edge is ignored, so b has no children.
    expect(rootA.children).toEqual([{ url: 'https://x/c', via: { kind: 'link' }, children: [] }])
    expect(rootB.children).toEqual([])
    expect(sitemap.orphans).toEqual([])
  })

  it('orphan: a page URL that appears in no edge at all is listed in orphans, not roots', () => {
    const edges: NavEdge[] = [{ from: 'https://x/a', to: 'https://x/b', kind: 'link' }]
    const pages = ['https://x/a', 'https://x/b', 'https://x/orphan']

    const sitemap = buildSitemap(edges, pages, { now: NOW })

    expect(sitemap.orphans).toEqual(['https://x/orphan'])
    expect(sitemap.roots).toHaveLength(1)
    expect(sitemap.roots[0].url).toBe('https://x/a')
    expect(sitemap.roots[0].children).toEqual([{ url: 'https://x/b', via: { kind: 'link' }, children: [] }])
  })

  it('cycle A→B→A: terminates instead of recursing forever', () => {
    const edges: NavEdge[] = [
      { from: 'https://x/a', to: 'https://x/b', kind: 'link' },
      { from: 'https://x/b', to: 'https://x/a', kind: 'link' },
    ]
    const pages = ['https://x/a', 'https://x/b']

    const sitemap = buildSitemap(edges, pages, { now: NOW })

    // Both nodes end up parented by each other — neither is parentless, so the mutually-cyclic
    // pair roots nothing and orphans nothing. The key assertion is that this call returns at all
    // (synchronously, without a stack overflow) rather than hanging in infinite recursion.
    expect(sitemap.roots).toEqual([])
    expect(sitemap.orphans).toEqual([])
    expect(() => JSON.stringify(sitemap)).not.toThrow()
  })

  it('cycle-safe guard also bounds a root whose subtree loops back on itself (R→A→B→A)', () => {
    const edges: NavEdge[] = [
      { from: 'https://x/r', to: 'https://x/a', kind: 'link' },
      { from: 'https://x/a', to: 'https://x/b', kind: 'link' },
      { from: 'https://x/b', to: 'https://x/a', kind: 'link' },
    ]
    const pages = ['https://x/r', 'https://x/a', 'https://x/b']

    const sitemap = buildSitemap(edges, pages, { now: NOW })

    expect(sitemap.roots).toHaveLength(1)
    expect(sitemap.roots[0].url).toBe('https://x/r')
    // r -> a -> b, and b's second edge back to a is ignored (a already has a parent: r).
    expect(sitemap.roots[0].children).toEqual([
      {
        url: 'https://x/a',
        via: { kind: 'link' },
        children: [{ url: 'https://x/b', via: { kind: 'link' }, children: [] }],
      },
    ])
  })

  it('defaults generatedAt to the current time when opts.now is omitted', () => {
    const before = Date.now()
    const sitemap = buildSitemap([], [])
    const after = Date.now()
    const ts = Date.parse(sitemap.generatedAt)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})
