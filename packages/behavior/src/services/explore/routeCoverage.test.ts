import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  updateCoverage,
  renderCoverageMarkdown,
  loadCoverageStore,
  saveCoverageStore,
} from './routeCoverage.js'
import type { CoverageStore } from './routeCoverage.js'
import type { RouteInventory } from './routeInventory.js'
import type { ApiTransaction } from '../../domain/transaction.js'

const inventory: RouteInventory = {
  source: 'structure',
  routes: [
    { key: 'GET /orders', method: 'GET', path: '/orders' },
    { key: 'POST /orders', method: 'POST', path: '/orders' },
    { key: 'GET /orders/:id', method: 'GET', path: '/orders/:id' },
  ],
}

function tx(over: Partial<ApiTransaction>): ApiTransaction {
  return {
    runId: 'r',
    seq: 0,
    ts: '2026-07-15T00:00:00.000Z',
    durationMs: 0,
    stage: 'explore',
    method: 'GET',
    url: 'http://app.test/orders',
    path: '/orders',
    resourceType: 'fetch',
    status: 200,
    ok: true,
    ...over,
  }
}

describe('updateCoverage', () => {
  it('covers matched routes from a fresh store, unioning owning-page screens', () => {
    const txs = [
      tx({ method: 'GET', path: '/orders', status: 200, pageUrl: 'http://app.test/orders' }),
      tx({ method: 'GET', path: '/orders/42', status: 200, pageUrl: 'http://app.test/orders/42' }),
    ]
    const { store, summary } = updateCoverage(null, inventory, txs, 'run1', '2026-07-15T01:00:00.000Z')
    expect(summary).toEqual({ total: 3, covered: 2, newlyCovered: 2, ratio: 2 / 3 })
    const byKey = Object.fromEntries(store.entries.map((e) => [e.key, e]))
    expect(byKey['GET /orders'].covered).toBe(true)
    expect(byKey['GET /orders'].firstCoveredRunId).toBe('run1')
    expect(byKey['GET /orders'].lastCoveredAt).toBe('2026-07-15T01:00:00.000Z')
    expect(byKey['GET /orders/:id'].screens).toEqual(['/orders/42']) // pathname label, matching the session log
    expect(byKey['POST /orders'].covered).toBe(false)
  })

  it('only successful (2xx/3xx) transactions cover — 401 probes, 500s, and failed requests do not', () => {
    const txs = [
      tx({ method: 'POST', path: '/orders', status: undefined, ok: false, failed: true }), // no response
      tx({ method: 'GET', path: '/orders', status: 401, ok: false }), // unauthorized probe
      tx({ method: 'GET', path: '/orders/7', status: 500, ok: false }), // server error
    ]
    const { summary } = updateCoverage(null, inventory, txs, 'run1', 'now')
    expect(summary.covered).toBe(0)
  })

  it('is cumulative: merge preserves firstCoveredRunId and only new matches count as newlyCovered', () => {
    const first = updateCoverage(
      null,
      inventory,
      [tx({ method: 'GET', path: '/orders', pageUrl: 'http://app.test/orders' })],
      'run1',
      't1',
    ).store
    const { store, summary } = updateCoverage(
      first,
      inventory,
      [
        tx({ method: 'GET', path: '/orders', pageUrl: 'http://app.test/list' }), // already covered
        tx({ method: 'POST', path: '/orders', status: 201 }), // newly covered
      ],
      'run2',
      't2',
    )
    expect(summary.newlyCovered).toBe(1)
    const byKey = Object.fromEntries(store.entries.map((e) => [e.key, e]))
    expect(byKey['GET /orders'].firstCoveredRunId).toBe('run1') // preserved
    expect(byKey['GET /orders'].lastCoveredAt).toBe('t2') // refreshed this run
    expect(byKey['GET /orders'].screens).toEqual(['/list', '/orders']) // union, sorted, pathname labels
    expect(byKey['POST /orders'].firstCoveredRunId).toBe('run2')
  })

  it('drops keys no longer in the inventory (inventory shrink)', () => {
    const prev = updateCoverage(null, inventory, [tx({ method: 'GET', path: '/orders' })], 'run1', 't1').store
    const shrunk: RouteInventory = { source: 'structure', routes: [{ key: 'POST /orders', method: 'POST', path: '/orders' }] }
    const { store } = updateCoverage(prev, shrunk, [], 'run2', 't2')
    expect(store.entries.map((e) => e.key)).toEqual(['POST /orders'])
  })

  it('ratio is 0 when the inventory is empty', () => {
    const { summary } = updateCoverage(null, { source: 'file', routes: [] }, [], 'run1', 't')
    expect(summary).toEqual({ total: 0, covered: 0, newlyCovered: 0, ratio: 0 })
  })
})

describe('renderCoverageMarkdown', () => {
  it('renders the summary line and both checklists', () => {
    const store: CoverageStore = {
      source: 'structure',
      updatedAt: '2026-07-15T01:00:00.000Z',
      total: 2,
      covered: 1,
      entries: [
        { key: 'GET /orders', method: 'GET', path: '/orders', covered: true, screens: ['/orders'], lastCoveredAt: 't1' },
        { key: 'POST /orders', method: 'POST', path: '/orders', covered: false },
      ],
    }
    const md = renderCoverageMarkdown(store)
    expect(md).toContain('# ルート網羅状況')
    expect(md).toContain('**1 / 2 routes (50.0%)** — 更新: 2026-07-15T01:00:00.000Z (source: structure)')
    expect(md).toContain('## 未網羅 (1)')
    expect(md).toContain('- [ ] POST /orders')
    expect(md).toContain('## 網羅済み (1)')
    expect(md).toContain('- [x] GET /orders — screens: /orders (last: t1)')
  })
})

describe('coverage IO round-trip', () => {
  it('saves and reloads the store; returns null when missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cov-'))
    expect(await loadCoverageStore(root)).toBeNull()
    const { store } = updateCoverage(null, inventory, [tx({ method: 'GET', path: '/orders' })], 'run1', 't1')
    await saveCoverageStore(root, store)
    const reloaded = await loadCoverageStore(root)
    expect(reloaded).toEqual(store)
  })
})
