import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeScreenPath,
  updateScreenCoverage,
  renderScreenCoverageMarkdown,
  loadScreenCoverageStore,
  saveScreenCoverageStore,
} from './screenCoverage.js'
import type { ScreenCoverageStore } from './screenCoverage.js'
import type { ScreenInventory } from './inventory.js'

const inventory: ScreenInventory = {
  source: 'nextjs-app-router',
  screens: [{ path: '/' }, { path: '/hotel/:id' }, { path: '/settings' }],
}

describe('normalizeScreenPath', () => {
  it('lowercases, strips trailing slash, and collapses id-ish + templated segments to :id', () => {
    expect(normalizeScreenPath('/')).toBe('/')
    expect(normalizeScreenPath('/Hotel/')).toBe('/hotel')
    expect(normalizeScreenPath('/hotel/123')).toBe('/hotel/:id')
    expect(normalizeScreenPath('/hotel/:id')).toBe('/hotel/:id')
    expect(normalizeScreenPath('/hotel/[id]')).toBe('/hotel/:id')
    expect(normalizeScreenPath('/order/550e8400-e29b-41d4-a716-446655440000')).toBe('/order/:id')
    expect(normalizeScreenPath('/settings?tab=1')).toBe('/settings')
  })
})

describe('updateScreenCoverage', () => {
  it('covers screens whose concrete visited path matches (templated :id ↔ numeric)', () => {
    const visited = ['/', '/hotel/42']
    const { store, summary } = updateScreenCoverage(null, inventory, visited, 'run1', 't1')
    expect(summary).toEqual({ total: 3, covered: 2, newlyCovered: 2, ratio: 2 / 3 })
    const byKey = Object.fromEntries(store.entries.map((e) => [e.key, e]))
    expect(byKey['/'].covered).toBe(true)
    expect(byKey['/hotel/:id'].covered).toBe(true)
    expect(byKey['/hotel/:id'].firstCoveredRunId).toBe('run1')
    expect(byKey['/hotel/:id'].lastCoveredAt).toBe('t1')
    expect(byKey['/settings'].covered).toBe(false)
  })

  it('is cumulative: preserves firstCoveredRunId, refreshes lastCoveredAt, counts only new', () => {
    const first = updateScreenCoverage(null, inventory, ['/hotel/1'], 'run1', 't1').store
    const { store, summary } = updateScreenCoverage(first, inventory, ['/hotel/2', '/settings'], 'run2', 't2')
    expect(summary.newlyCovered).toBe(1) // /settings; /hotel/:id was already covered
    const byKey = Object.fromEntries(store.entries.map((e) => [e.key, e]))
    expect(byKey['/hotel/:id'].firstCoveredRunId).toBe('run1') // preserved
    expect(byKey['/hotel/:id'].lastCoveredAt).toBe('t2') // refreshed
    expect(byKey['/settings'].firstCoveredRunId).toBe('run2')
  })

  it('drops keys no longer in the inventory (inventory shrink)', () => {
    const prev = updateScreenCoverage(null, inventory, ['/settings'], 'run1', 't1').store
    const shrunk: ScreenInventory = { source: 'nextjs-app-router', screens: [{ path: '/' }] }
    const { store } = updateScreenCoverage(prev, shrunk, [], 'run2', 't2')
    expect(store.entries.map((e) => e.key)).toEqual(['/'])
  })

  it('de-duplicates inventory screens that collapse to the same key', () => {
    const dup: ScreenInventory = { source: 'nextjs-pages', screens: [{ path: '/user/:id' }, { path: '/user/[uid]' }] }
    const { summary } = updateScreenCoverage(null, dup, [], 'run1', 't1')
    expect(summary.total).toBe(1)
  })

  it('ratio is 0 when the inventory is empty', () => {
    const { summary } = updateScreenCoverage(null, { source: 'nextjs-pages', screens: [] }, [], 'run1', 't')
    expect(summary).toEqual({ total: 0, covered: 0, newlyCovered: 0, ratio: 0 })
  })
})

describe('renderScreenCoverageMarkdown', () => {
  it('renders the Japanese summary line and both checklists', () => {
    const store: ScreenCoverageStore = {
      source: 'nextjs-app-router',
      updatedAt: '2026-07-15T01:00:00.000Z',
      total: 2,
      covered: 1,
      entries: [
        { key: '/', path: '/', covered: true, lastCoveredAt: 't1' },
        { key: '/settings', path: '/settings', covered: false },
      ],
    }
    const md = renderScreenCoverageMarkdown(store)
    expect(md).toContain('# 画面網羅状況')
    expect(md).toContain('**1 / 2 screens (50.0%)** — 更新: 2026-07-15T01:00:00.000Z (source: nextjs-app-router)')
    expect(md).toContain('## 未網羅 (1)')
    expect(md).toContain('- [ ] /settings')
    expect(md).toContain('## 網羅済み (1)')
    expect(md).toContain('- [x] / (last: t1)')
  })
})

describe('screen coverage IO round-trip', () => {
  it('saves and reloads the store; returns null when missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scov-'))
    expect(await loadScreenCoverageStore(root)).toBeNull()
    const { store } = updateScreenCoverage(null, inventory, ['/settings'], 'run1', 't1')
    await saveScreenCoverageStore(root, store)
    const reloaded = await loadScreenCoverageStore(root)
    expect(reloaded).toEqual(store)
  })
})
