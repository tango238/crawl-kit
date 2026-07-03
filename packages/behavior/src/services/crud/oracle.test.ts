import { describe, it, expect } from 'vitest'
import { crudFinding } from './oracle.js'

describe('crudFinding', () => {
  it('creates a high-severity crud finding', () => {
    const f = crudFinding('orders', 'delete', '削除後も行が残っている')
    expect(f.category).toBe('crud')
    expect(f.severity).toBe('high')
    expect(f.title).toContain('delete')
    expect(f.title).toContain('orders')
    expect(f.detail).toContain('削除後も行が残っている')
    expect(f.evidence).toContain('entity=orders')
    expect(f.evidence).toContain('step=delete')
  })
})
