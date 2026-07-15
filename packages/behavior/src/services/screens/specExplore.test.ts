import { describe, it, expect, vi } from 'vitest'
import {
  specToForm,
  specToConstraints,
  specBaseline,
  resolveFkInputs,
  orderScreensByDependency,
} from './specExplore.js'
import type { ScreenSpec, ScreenSpecInput } from './spec.js'
import type { DbAdapter } from '../db/adapter.js'

const input = (over: Partial<ScreenSpecInput> = {}): ScreenSpecInput => ({
  field: 'name',
  constraints: { field: 'name', type: 'string', required: true, min: 1, max: 255 },
  value: 'ck-r1 name',
  ...over,
})

const spec = (over: Partial<ScreenSpec> = {}): ScreenSpec => ({
  screen: '/orders/create',
  analyzedAt: 't',
  uses: [{ method: 'POST', path: '/orders' }],
  submits: { endpoint: { method: 'POST', path: '/orders' }, inputs: [input()] },
  displays: [],
  ...over,
})

describe('specToForm', () => {
  it('maps submit inputs to name-selector fields with html types', () => {
    const s = spec({
      submits: {
        endpoint: { method: 'POST', path: '/orders' },
        inputs: [
          input({ field: 'name', label: '名称' }),
          input({ field: 'price', constraints: { field: 'price', type: 'number', required: true } }),
          input({ field: 'contact', constraints: { field: 'contact', type: 'string', required: false, email: true } }),
        ],
      },
    })
    const form = specToForm(s, '/orders/create')
    expect(form).toEqual({
      screenPath: '/orders/create',
      submitSelector: 'button[type="submit"]',
      fields: [
        { name: 'name', selector: '[name="name"]', htmlType: 'text', label: '名称' },
        { name: 'price', selector: '[name="price"]', htmlType: 'number' },
        { name: 'contact', selector: '[name="contact"]', htmlType: 'email' },
      ],
    })
  })

  it('returns null when the spec has no submit', () => {
    expect(specToForm(spec({ submits: undefined }), '/orders')).toBeNull()
  })
})

describe('specToConstraints', () => {
  it('maps string min/max to LENGTH bounds and number min/max to VALUE bounds', () => {
    const s = spec({
      submits: {
        endpoint: { method: 'POST', path: '/orders' },
        inputs: [
          input({ field: 'name', constraints: { field: 'name', type: 'string', required: true, min: 1, max: 255 } }),
          input({ field: 'qty', constraints: { field: 'qty', type: 'number', required: true, min: 0, max: 99 } }),
          input({ field: 'kind', constraints: { field: 'kind', type: 'enum', required: true, enumValues: ['a', 'b'] } }),
        ],
      },
    })
    const [name, qty, kind] = specToConstraints(s)
    expect(name).toMatchObject({ type: 'string', minLength: 1, maxLength: 255, min: undefined, max: undefined })
    expect(qty).toMatchObject({ type: 'number', min: 0, max: 99, minLength: undefined, maxLength: undefined })
    expect(kind).toMatchObject({ type: 'enum', enumValues: ['a', 'b'] })
    expect(name.evidence).toContain('screen-spec')
  })
})

describe('specBaseline', () => {
  it('maps selector → pre-generated value, skipping inputs without a value', () => {
    const s = spec({
      submits: {
        endpoint: { method: 'POST', path: '/orders' },
        inputs: [input({ field: 'name', value: 'v1' }), input({ field: 'memo', value: undefined })],
      },
    })
    expect(specBaseline(s)).toEqual({ '[name="name"]': 'v1' })
  })
})

describe('resolveFkInputs', () => {
  const db = (rowsByTable: Record<string, { id: number }[]>): DbAdapter =>
    ({
      query: vi.fn(async (sql: string) => {
        const table = /FROM (\w+)/.exec(sql)?.[1] ?? ''
        if (!(table in rowsByTable)) throw new Error('no table')
        return rowsByTable[table]
      }),
    }) as unknown as DbAdapter

  it('replaces the placeholder with the first existing id (plural table first)', async () => {
    const inputs = [input({ field: 'hotel_id', fkHint: 'hotel', value: '1' })]
    const out = await resolveFkInputs(inputs, db({ hotels: [{ id: 42 }] }))
    expect(out[0].value).toBe('42')
  })

  it('keeps the placeholder when no table matches, and passes non-FK inputs through', async () => {
    const inputs = [input({ field: 'hotel_id', fkHint: 'hotel', value: '1' }), input({ field: 'name' })]
    const out = await resolveFkInputs(inputs, db({}))
    expect(out[0].value).toBe('1')
    expect(out[1]).toEqual(inputs[1])
  })
})

describe('orderScreensByDependency', () => {
  it('places the screen that creates a resource before screens whose inputs reference it', () => {
    const specs: ScreenSpec[] = [
      spec({
        screen: '/booking/create',
        submits: {
          endpoint: { method: 'POST', path: '/bookings' },
          inputs: [input({ field: 'hotel_id', fkHint: 'hotel' })],
        },
      }),
      spec({
        screen: '/hotel/create',
        submits: { endpoint: { method: 'POST', path: '/hotels' }, inputs: [input()] },
      }),
    ]
    const ordered = orderScreensByDependency(['/booking/create', '/hotel/create'], specs)
    expect(ordered).toEqual(['/hotel/create', '/booking/create'])
  })

  it('keeps original order for spec-less screens and survives cycles', () => {
    const a = spec({
      screen: '/a',
      submits: { endpoint: { method: 'POST', path: '/as' }, inputs: [input({ field: 'b_id', fkHint: 'b' })] },
    })
    const b = spec({
      screen: '/b',
      submits: { endpoint: { method: 'POST', path: '/bs' }, inputs: [input({ field: 'a_id', fkHint: 'a' })] },
    })
    expect(orderScreensByDependency(['/x', '/a', '/b'], [a, b])).toEqual(['/x', '/b', '/a'])
  })
})
