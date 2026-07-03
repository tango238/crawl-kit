import { describe, expect, it } from 'vitest'
import { annotatePersistence } from './tx-persistence.js'
import type { CrudResultsLike } from './tx-persistence.js'

const crudResults: CrudResultsLike = [
  {
    entity: 'orders',
    route: 'POST /orders',
    savedColumns: ['title'],
    steps: [{ step: 'create', route: 'POST /orders', ok: true, detail: 'saved title', dbProbed: true }],
  },
  {
    entity: 'customers',
    route: 'POST /customers',
    savedColumns: [],
    steps: [{ step: 'create', route: 'POST /customers', ok: false, detail: 'not persisted', dbProbed: true }],
  },
  {
    entity: 'orders',
    route: 'POST /orders',
    savedColumns: ['title'],
    steps: [
      { step: 'create', route: 'POST /orders', ok: true, detail: 'saved title', dbProbed: true },
      { step: 'update', route: 'PATCH /orders/:id', ok: true, detail: 'updated title', dbProbed: true },
      { step: 'delete', route: 'DELETE /orders/:id', ok: false, detail: 'row still present', dbProbed: true },
    ],
  },
  {
    entity: 'invoices',
    route: 'POST /invoices',
    savedColumns: [],
    steps: [
      { step: 'create', route: 'POST /invoices', ok: true, detail: 'status 201 (DB未接続で status のみ)', dbProbed: false },
    ],
  },
]

describe('annotatePersistence', () => {
  it('marks GET/HEAD/OPTIONS as undefined (no persistence question)', () => {
    expect(annotatePersistence({ method: 'GET', path: '/orders' }, crudResults)).toBeUndefined()
    expect(annotatePersistence({ method: 'HEAD', path: '/orders' }, crudResults)).toBeUndefined()
    expect(annotatePersistence({ method: 'OPTIONS', path: '/orders' }, crudResults)).toBeUndefined()
  })

  it('marks a mutation matched with oracle success as "yes"', () => {
    expect(annotatePersistence({ method: 'PATCH', path: '/orders/123' }, crudResults)).toBe('yes')
  })

  it('marks a mutation matched with oracle failure as "no"', () => {
    expect(annotatePersistence({ method: 'DELETE', path: '/orders/123' }, crudResults)).toBe('no')
    expect(annotatePersistence({ method: 'POST', path: '/customers' }, crudResults)).toBe('no')
  })

  it('marks an unmatched mutation as "unknown"', () => {
    expect(annotatePersistence({ method: 'POST', path: '/refunds' }, crudResults)).toBe('unknown')
  })

  it('marks a matched-but-unprobed step ("ok" but no DB adapter) as "unknown", not "yes"', () => {
    // POST /invoices' step is ok:true but dbProbed:false (status-only, no DB adapter) —
    // this is the honesty fix: a matched step alone is not enough to claim "yes".
    expect(annotatePersistence({ method: 'POST', path: '/invoices' }, crudResults)).toBe('unknown')
  })

  it('normalizes :id-shaped path segments before matching (existing convention)', () => {
    expect(annotatePersistence({ method: 'PATCH', path: '/orders/999' }, crudResults)).toBe('yes')
  })

  it('is case-insensitive on method', () => {
    expect(annotatePersistence({ method: 'post', path: '/orders' }, crudResults)).toBe('yes')
  })
})
