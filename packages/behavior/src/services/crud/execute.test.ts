import { describe, it, expect } from 'vitest'
import { executeCrudPlan } from './execute.js'
import type { CrudPlan } from './types.js'

const resp = (status: number, body: unknown = {}) => ({
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

function fakeApi(byMethod: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = []
  return {
    calls,
    request: async (m: string, u: string) => {
      calls.push(`${m} ${u}`)
      const r = byMethod[m] ?? { status: 200 }
      return resp(r.status, r.body)
    },
  }
}

const plan: CrudPlan = {
  entity: 'orders',
  table: 'orders',
  idColumn: 'id',
  create: { method: 'POST', path: '/orders' },
  update: { method: 'PATCH', path: '/orders/:id', updatableColumn: 'title' },
  delete: { method: 'DELETE', path: '/orders/:id' },
  body: { title: 'X' },
}

describe('executeCrudPlan', () => {
  it('runs create→update→delete happy path with no findings', async () => {
    const api = fakeApi({ POST: { status: 201, body: { id: 7 } }, PATCH: { status: 200 }, DELETE: { status: 204 } })
    const db = { query: async () => [{ '1': 1 }], close: async () => {} }
    const { findings, result } = await executeCrudPlan(plan, {
      api: api as never,
      db: db as never,
      dbType: 'postgres',
      wasValueSaved: async () => true,
      wasValueAbsent: async () => true,
    })
    expect(findings).toHaveLength(0)
    expect(api.calls).toEqual(['POST /orders', 'PATCH /orders/7', 'DELETE /orders/7'])
    expect(result.savedColumns.length).toBeGreaterThan(0)
  })

  it('emits a finding when delete leaves the row behind', async () => {
    const api = fakeApi({ POST: { status: 201, body: { id: 7 } }, PATCH: { status: 200 }, DELETE: { status: 200 } })
    const db = { query: async () => [{}], close: async () => {} }
    const { findings } = await executeCrudPlan(plan, {
      api: api as never,
      db: db as never,
      dbType: 'postgres',
      wasValueSaved: async () => true,
      wasValueAbsent: async () => false,
    })
    expect(findings.some((f) => f.detail.includes('削除'))).toBe(true)
  })

  it('stops after a failed create (non-2xx)', async () => {
    const api = fakeApi({ POST: { status: 500 } })
    const { findings } = await executeCrudPlan(plan, {
      api: api as never,
      dbType: 'postgres',
      wasValueSaved: async () => true,
      wasValueAbsent: async () => true,
    })
    expect(api.calls).toEqual(['POST /orders'])
    expect(findings.some((f) => f.title.includes('create'))).toBe(true)
  })

  describe('dbProbed', () => {
    it('is true on every step when a DB adapter is available and the probe ran (ok:true and ok:false)', async () => {
      const api = fakeApi({ POST: { status: 201, body: { id: 7 } }, PATCH: { status: 200 }, DELETE: { status: 200 } })
      const db = { query: async () => [{}], close: async () => {} }
      const { result } = await executeCrudPlan(plan, {
        api: api as never,
        db: db as never,
        dbType: 'postgres',
        wasValueSaved: async () => true, // create/update: ok:true, dbProbed:true
        wasValueAbsent: async () => false, // delete: ok:false, dbProbed:true (row still present)
      })
      expect(result.steps.every((s) => s.dbProbed === true)).toBe(true)
      expect(result.steps.find((s) => s.step === 'delete')?.ok).toBe(false)
    })

    it('is false on every step when no DB adapter is given (status-only path)', async () => {
      const api = fakeApi({ POST: { status: 201, body: { id: 7 } }, PATCH: { status: 200 }, DELETE: { status: 204 } })
      const { result } = await executeCrudPlan(plan, {
        api: api as never,
        dbType: 'postgres',
        wasValueSaved: async () => true,
        wasValueAbsent: async () => true,
      })
      expect(result.steps).toHaveLength(3)
      expect(result.steps.every((s) => s.dbProbed === false)).toBe(true)
      // status-only steps still report ok:true from the HTTP status alone.
      expect(result.steps.every((s) => s.ok === true)).toBe(true)
    })

    it('is false on a step whose HTTP request itself failed (never reached a DB check)', async () => {
      const api = fakeApi({ POST: { status: 500 } })
      const db = { query: async () => [{}], close: async () => {} }
      const { result } = await executeCrudPlan(plan, {
        api: api as never,
        db: db as never,
        dbType: 'postgres',
        wasValueSaved: async () => true,
        wasValueAbsent: async () => true,
      })
      expect(result.steps).toEqual([
        expect.objectContaining({ step: 'create', ok: false, dbProbed: false }),
      ])
    })
  })
})
