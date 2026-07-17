import { describe, it, expect } from 'vitest'
import { valueForField } from './values.js'
import type { FieldConstraintSpec } from './zodParse.js'

const field = (over: Partial<FieldConstraintSpec>): FieldConstraintSpec => ({
  field: 'x',
  type: 'string',
  required: true,
  ...over,
})

describe('valueForField', () => {
  it('returns null for containers it cannot fill', () => {
    expect(valueForField(field({ type: 'object' }), 'r1')).toBeNull()
    expect(valueForField(field({ type: 'array' }), 'r1')).toBeNull()
    expect(valueForField(field({ type: 'unknown' }), 'r1')).toBeNull()
  })

  it('embeds the runId in emails so unique columns do not collide', () => {
    expect(valueForField(field({ field: 'email', email: true }), 'r1')).toEqual({
      value: 'ck-r1@example.com',
    })
    expect(valueForField(field({ field: 'contactEmail' }), 'abc')).toEqual({
      value: 'ck-abc@example.com',
    })
  })

  it('treats *_id / *Id as foreign keys with an entity hint', () => {
    expect(valueForField(field({ field: 'customerId', type: 'number' }), 'r1')).toEqual({
      value: '1',
      fkHint: 'customer',
    })
    expect(valueForField(field({ field: 'order_id', type: 'number' }), 'r1')).toEqual({
      value: '1',
      fkHint: 'order',
    })
  })

  it('picks the first enum value', () => {
    expect(valueForField(field({ type: 'enum', enumValues: ['a', 'b'] }), 'r1')).toEqual({ value: 'a' })
  })

  it('uses true for booleans', () => {
    expect(valueForField(field({ type: 'boolean' }), 'r1')).toEqual({ value: 'true' })
  })

  it('uses the numeric min, defaulting to 1 and clamping to max', () => {
    expect(valueForField(field({ type: 'number', min: 3 }), 'r1')).toEqual({ value: '3' })
    expect(valueForField(field({ type: 'number' }), 'r1')).toEqual({ value: '1' })
    expect(valueForField(field({ type: 'number', min: 10, max: 5 }), 'r1')).toEqual({ value: '5' })
  })

  it('uses a fixed date for date types and date-ish names', () => {
    expect(valueForField(field({ type: 'date' }), 'r1')).toEqual({ value: '2026-01-15' })
    expect(valueForField(field({ field: 'createdAt' }), 'r1')).toEqual({ value: '2026-01-15' })
  })

  it('uses a fixed phone number respecting max length', () => {
    expect(valueForField(field({ field: 'phoneNumber' }), 'r1')).toEqual({ value: '05012345678' })
    expect(valueForField(field({ field: 'tel', max: 4 }), 'r1')).toEqual({ value: '0501' })
  })

  it('builds free text with the runId, truncated to max', () => {
    expect(valueForField(field({ field: 'name' }), 'r1')).toEqual({ value: 'ck-r1 name' })
    expect(valueForField(field({ field: 'name', max: 5 }), 'r1')).toEqual({ value: 'ck-r1' })
  })

  it('is deterministic across calls', () => {
    const c = field({ field: 'title', max: 20 })
    expect(valueForField(c, 'run-9')).toEqual(valueForField(c, 'run-9'))
  })
})
