import { describe, it, expect } from 'vitest'
import { analyzeScreens, type DirEntry } from './analyze.js'

// A synthetic Next.js App Router frontend held entirely in memory, keyed by absolute path.
const files: Record<string, string> = {
  '/fe/api/orders/orders.ts': `
    import { axiosInstance } from '../../lib/httpClient'
    export const ordersIndex = (params, options) => {
      return axiosInstance({ url: \`/v2/orders\`, method: 'GET', params }, options)
    }
    export const useOrdersIndex = (params, options) => {
      const swrFn = () => ordersIndex(params, requestOptions)
      return useSwr(swrKey, swrFn)
    }
    export const ordersStore = (body, options) => {
      return axiosInstance({ url: \`/v2/orders\`, method: 'POST', data: body }, options)
    }
  `,
  '/fe/api/orders/orders.zod.ts': `
    import * as zod from 'zod'
    export const OrdersStoreBody = zod.object({
      name: zod.string().min(1).max(120),
      customerId: zod.number(),
    })
    export const OrdersIndexResponse = zod.object({
      data: zod.array(zod.object({ id: zod.number() })),
      total: zod.number(),
    })
  `,
  '/fe/app/(dashboard)/orders/page.tsx': `
    import { OrdersTable } from '@/features/orders/components'
    export default function Page() { return <OrdersTable /> }
  `,
  '/fe/features/orders/components/index.ts': `export * from './OrdersTable'`,
  '/fe/features/orders/components/OrdersTable.tsx': `
    import { useOrdersIndex, ordersStore } from '@/api/orders/orders'
    export function OrdersTable() {
      const { data } = useOrdersIndex()
      async function onSubmit(v) { await ordersStore(v) }
      return (
        <form>
          <FormLabel>Order name</FormLabel>
          <input name="name" />
        </form>
      )
    }
  `,
}

const memDeps = {
  readFile: async (p: string): Promise<string> => {
    if (p in files) return files[p]
    throw new Error(`ENOENT ${p}`)
  },
  readDir: async (dir: string): Promise<DirEntry[]> => {
    const norm = dir.replace(/\/$/, '')
    const dirs = new Set<string>()
    const names = new Set<string>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${norm}/`)) continue
      const rest = path.slice(norm.length + 1)
      const slash = rest.indexOf('/')
      if (slash === -1) names.add(rest)
      else dirs.add(rest.slice(0, slash))
    }
    if (dirs.size === 0 && names.size === 0) throw new Error(`ENOENT ${dir}`)
    return [
      ...[...dirs].map((name) => ({ name, isDirectory: true })),
      ...[...names].map((name) => ({ name, isDirectory: false })),
    ]
  },
}

const opts = { runId: 'r1', now: '2026-01-01T00:00:00Z' }

describe('analyzeScreens', () => {
  it('maps a route (through a route group) to the endpoints its import graph references', async () => {
    const [spec] = await analyzeScreens('/fe', [{ path: '/orders' }], opts, memDeps)
    expect(spec.screen).toBe('/orders')
    expect(spec.analyzedAt).toBe('2026-01-01T00:00:00Z')
    expect(spec.uses).toContainEqual({ method: 'GET', path: '/v2/orders' })
    expect(spec.uses).toContainEqual({ method: 'POST', path: '/v2/orders' })
  })

  it('builds submits from the first mutation, with deterministic values and a form label', async () => {
    const [spec] = await analyzeScreens('/fe', [{ path: '/orders' }], opts, memDeps)
    expect(spec.submits?.endpoint).toEqual({ method: 'POST', path: '/v2/orders' })
    const byField = Object.fromEntries((spec.submits?.inputs ?? []).map((i) => [i.field, i]))
    expect(byField.name).toMatchObject({ label: 'Order name', value: 'ck-r1 name' })
    expect(byField.customerId).toMatchObject({ value: '1', fkHint: 'customer' })
  })

  it('builds displays from the primary GET response schema', async () => {
    const [spec] = await analyzeScreens('/fe', [{ path: '/orders' }], opts, memDeps)
    expect(spec.displays.map((d) => d.field)).toEqual(['data', 'total'])
  })

  it('produces an empty-uses spec (never throws) for a route with no page', async () => {
    const [spec] = await analyzeScreens('/fe', [{ path: '/missing' }], opts, memDeps)
    expect(spec).toMatchObject({ screen: '/missing', uses: [], displays: [] })
    expect(spec.submits).toBeUndefined()
  })
})
