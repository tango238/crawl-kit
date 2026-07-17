import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveScreenSpecs, loadScreenSpecs, specForScreen, screenSlug, type ScreenSpec } from './spec.js'

const spec = (over: Partial<ScreenSpec>): ScreenSpec => ({
  screen: '/orders',
  analyzedAt: '2026-01-01T00:00:00Z',
  uses: [],
  displays: [],
  ...over,
})

describe('screenSlug', () => {
  it('slugifies templated routes', () => {
    expect(screenSlug('/orders/:id')).toBe('orders-_id')
    expect(screenSlug('/orders')).toBe('orders')
    expect(screenSlug('/')).toBe('index')
  })
})

describe('saveScreenSpecs / loadScreenSpecs', () => {
  it('round-trips specs through YAML + index.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'screen-specs-'))
    const specs = [
      spec({
        screen: '/orders',
        uses: [{ method: 'GET', path: '/v2/orders' }],
        displays: [{ field: 'id' }],
      }),
      spec({
        screen: '/orders/:id',
        submits: { endpoint: { method: 'POST', path: '/v2/orders' }, inputs: [] },
      }),
    ]
    await saveScreenSpecs(root, specs)
    const loaded = await loadScreenSpecs(root)
    expect(loaded).toEqual(specs)
  })

  it('returns [] when never analyzed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'screen-specs-empty-'))
    expect(await loadScreenSpecs(root)).toEqual([])
  })
})

describe('specForScreen', () => {
  const specs = [
    spec({ screen: '/orders' }),
    spec({ screen: '/orders/:id' }),
    spec({ screen: '/orders/new' }),
  ]

  it('matches a concrete path against a templated screen', () => {
    expect(specForScreen(specs, '/orders/42')?.screen).toBe('/orders/:id')
  })

  it('prefers the most specific (fewest param) match', () => {
    expect(specForScreen(specs, '/orders/new')?.screen).toBe('/orders/new')
  })

  it('returns null when nothing matches', () => {
    expect(specForScreen(specs, '/customers')).toBeNull()
  })
})
