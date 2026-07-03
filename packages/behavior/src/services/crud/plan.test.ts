import { describe, it, expect } from 'vitest'
import { buildCrudPlans, buildCrudPlansFromPartial, entitiesFromPartial, entityFromPath } from './plan.js'
import type { LayerNode } from '@crawl-kit/contract'
import type { ColumnDef } from '../explore/types.js'

const sn = (method: string, path: string, entity: string, crud: string[]): LayerNode => ({
  nodeId: `structure:route/${method} ${path}`,
  layer: 'structure',
  localName: `${method} ${path}`,
  route: `${method} ${path}`,
  raw: { kind: 'route', method, path, entity, crud },
  source: { tool: 'rdra' },
})

const cols: Record<string, ColumnDef[]> = {
  orders: [
    { name: 'id', dataType: 'integer', nullable: false },
    { name: 'title', dataType: 'text', nullable: false },
    { name: 'created_at', dataType: 'timestamp', nullable: false },
  ],
}

describe('buildCrudPlans', () => {
  it('derives create/update/delete + idColumn + body for an entity', () => {
    const plans = buildCrudPlans(
      [
        sn('POST', '/orders', 'orders', ['C']),
        sn('PATCH', '/orders/:id', 'orders', ['U']),
        sn('DELETE', '/orders/:id', 'orders', ['D']),
      ],
      cols,
    )
    expect(plans).toHaveLength(1)
    const p = plans[0]!
    expect(p.create).toEqual({ method: 'POST', path: '/orders' })
    expect(p.update?.path).toBe('/orders/:id')
    expect(p.update?.updatableColumn).toBe('title')
    expect(p.delete?.method).toBe('DELETE')
    expect(p.idColumn).toBe('id')
    expect(Object.keys(p.body)).toContain('title')
    expect(Object.keys(p.body)).not.toContain('id')
    expect(Object.keys(p.body)).not.toContain('created_at')
  })

  it('skips entities with no create route', () => {
    expect(buildCrudPlans([sn('DELETE', '/orders/:id', 'orders', ['D'])], cols)).toHaveLength(0)
  })

  it('prefers bodyByTable when provided', () => {
    const plans = buildCrudPlans([sn('POST', '/orders', 'orders', ['C'])], cols, { orders: { title: 'Observed' } })
    expect(plans[0]!.body).toEqual({ title: 'Observed' })
  })
})

describe('entityFromPath', () => {
  it('infers the entity from the last resource segment, skipping id/params/prefixes', () => {
    expect(entityFromPath('/orders')).toBe('orders')
    expect(entityFromPath('/orders/:id')).toBe('orders')
    expect(entityFromPath('/api/v1/users/:id')).toBe('users')
    expect(entityFromPath('/admin/users/{user}/roles')).toBe('roles')
    expect(entityFromPath('/api/v2/123')).toBe('')
  })
})

describe('entitiesFromPartial', () => {
  it('collects distinct inferred entities', () => {
    expect(
      entitiesFromPartial([
        { method: 'POST', path: '/orders' },
        { method: 'PATCH', path: '/orders/:id' },
        { method: 'POST', path: '/api/v1/users' },
      ]).sort(),
    ).toEqual(['orders', 'users'])
  })
})

describe('buildCrudPlansFromPartial', () => {
  it('builds plans from a Pass-1 partial (entity inferred from path)', () => {
    const plans = buildCrudPlansFromPartial(
      [
        { method: 'POST', path: '/orders' },
        { method: 'PATCH', path: '/orders/:id' },
        { method: 'DELETE', path: '/orders/:id' },
      ],
      cols,
    )
    expect(plans).toHaveLength(1)
    const p = plans[0]!
    expect(p.entity).toBe('orders')
    expect(p.create).toEqual({ method: 'POST', path: '/orders' })
    expect(p.update?.updatableColumn).toBe('title')
    expect(p.delete?.method).toBe('DELETE')
  })

  it('skips inferred entities with no DB columns (unresolvable id)', () => {
    expect(buildCrudPlansFromPartial([{ method: 'POST', path: '/ghosts' }], cols)).toHaveLength(0)
  })
})
