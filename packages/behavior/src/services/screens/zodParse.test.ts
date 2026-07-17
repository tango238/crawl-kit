import { describe, it, expect } from 'vitest'
import { parseZodObject, requestSchemaNameFor, responseSchemaNameFor } from './zodParse.js'
import type { HookIndex } from './orval.js'

// Synthetic zod-mode output shaped like orval's `.zod.ts` (generic orders domain).
const ordersZod = `
import * as zod from 'zod'

export const ordersStoreBodyNoteMax = 100

export const OrdersStoreBody = zod.object({
  name: zod.string().min(1).max(255),
  email: zod.string().email(),
  price: zod.number().min(0),
  kind: zod.enum(['standard', 'express']),
  note: zod.string().max(ordersStoreBodyNoteMax).optional(),
  customerId: zod.number(),
  tags: zod.array(zod.string()).nullish(),
  metadata: zod.object({ a: zod.string() }).nullable(),
  code: zod.string().regex(/^[A-Z]{3}$/),
  shipAt: zod.string().datetime({}),
})

export const OrdersStoreResponse = zod.object({
  data: zod.object({ id: zod.number() }),
})

export const OrdersIndexResponse = zod.object({
  data: zod.array(zod.object({ id: zod.number() })),
  total: zod.number(),
})
`

const zodSources = [{ file: 'orders.zod.ts', text: ordersZod }]

describe('parseZodObject', () => {
  const fields = parseZodObject(ordersZod, 'OrdersStoreBody')!
  const byName = Object.fromEntries((fields ?? []).map((f) => [f.field, f]))

  it('parses a string with length bounds', () => {
    expect(byName.name).toMatchObject({ type: 'string', required: true, min: 1, max: 255 })
  })

  it('flags email strings', () => {
    expect(byName.email).toMatchObject({ type: 'string', email: true, required: true })
  })

  it('parses number bounds', () => {
    expect(byName.price).toMatchObject({ type: 'number', required: true, min: 0 })
  })

  it('parses enum values', () => {
    expect(byName.kind).toMatchObject({ type: 'enum', enumValues: ['standard', 'express'] })
  })

  it('marks optional fields not required and resolves a hoisted numeric const bound', () => {
    expect(byName.note).toMatchObject({ type: 'string', required: false, max: 100 })
  })

  it('treats nullish arrays as optional + nullable containers', () => {
    expect(byName.tags).toMatchObject({ type: 'array', required: false, nullable: true })
  })

  it('records nested objects as a single object field (no deep recursion)', () => {
    expect(byName.metadata).toMatchObject({ type: 'object', required: true, nullable: true })
  })

  it('captures a regex source', () => {
    expect(byName.code).toMatchObject({ type: 'string', regex: '^[A-Z]{3}$' })
  })

  it('classifies .datetime() strings as date', () => {
    expect(byName.shipAt).toMatchObject({ type: 'date', required: true })
  })

  it('returns null for an absent schema', () => {
    expect(parseZodObject(ordersZod, 'DoesNotExist')).toBeNull()
  })
})

describe('requestSchemaNameFor / responseSchemaNameFor', () => {
  const hookIndex: HookIndex = new Map([
    ['ordersStore', { method: 'POST', path: '/v2/orders' }],
    ['useOrdersStore', { method: 'POST', path: '/v2/orders' }],
    ['ordersIndex', { method: 'GET', path: '/v2/orders' }],
  ])

  it('maps an endpoint to its <PascalOperation>Body schema via the client index', () => {
    expect(requestSchemaNameFor({ method: 'POST', path: '/v2/orders' }, zodSources, hookIndex)).toEqual({
      name: 'OrdersStoreBody',
      file: 'orders.zod.ts',
    })
  })

  it('maps an endpoint to its <PascalOperation>Response schema', () => {
    expect(responseSchemaNameFor({ method: 'GET', path: '/v2/orders' }, zodSources, hookIndex)).toEqual({
      name: 'OrdersIndexResponse',
      file: 'orders.zod.ts',
    })
  })

  it('returns null when no schema matches', () => {
    expect(requestSchemaNameFor({ method: 'DELETE', path: '/v2/orders' }, zodSources, hookIndex)).toBeNull()
  })
})
