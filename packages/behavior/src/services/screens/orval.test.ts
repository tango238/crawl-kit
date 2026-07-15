import { describe, it, expect } from 'vitest'
import { parseOrvalClients } from './orval.js'

// Synthetic client source shaped like orval's tags-split swr output (generic orders domain).
const ordersClient = `
import useSwr from 'swr'
import { axiosInstance } from '../../lib/httpClient'

export const ordersIndex = (params, options) => {
  return axiosInstance<OrdersIndex200>(
    { url: \`/v2/orders\`, method: 'GET', params },
    options
  )
}

export const getOrdersIndexKey = (params) => [\`/v2/orders\`]

export const useOrdersIndex = (params, options) => {
  const swrFn = () => ordersIndex(params, requestOptions)
  return useSwr(swrKey, swrFn, swrOptions)
}

export const ordersStore = (body, options) => {
  return axiosInstance<OrdersStore200>(
    { url: \`/v2/orders\`, method: 'POST', headers: {}, data: body },
    options
  )
}

export const getOrdersStoreMutationFetcher = (options) => {
  return (_, { arg }) => {
    return ordersStore(arg, options)
  }
}

export const getOrdersStoreMutationKey = () => [\`/v2/orders\`]

export const useOrdersStore = (options) => {
  const swrFn = getOrdersStoreMutationFetcher(requestOptions)
  return useSWRMutation(swrKey, swrFn, swrOptions)
}

export const ordersShow = (orderId, options) => {
  return axiosInstance<OrdersShow200>(
    { url: \`/v2/orders/\${orderId}\`, method: 'GET' },
    options
  )
}
`

describe('parseOrvalClients', () => {
  it('reads endpoint from plain operation functions, normalizing template params', () => {
    const idx = parseOrvalClients([{ file: 'orders.ts', text: ordersClient }])
    expect(idx.get('ordersIndex')).toEqual({ method: 'GET', path: '/v2/orders' })
    expect(idx.get('ordersStore')).toEqual({ method: 'POST', path: '/v2/orders' })
    expect(idx.get('ordersShow')).toEqual({ method: 'GET', path: '/v2/orders/{orderId}' })
  })

  it('propagates the endpoint to SWR hook wrappers that delegate to the operation', () => {
    const idx = parseOrvalClients([{ file: 'orders.ts', text: ordersClient }])
    expect(idx.get('useOrdersIndex')).toEqual({ method: 'GET', path: '/v2/orders' })
  })

  it('resolves a two-hop delegation (hook -> mutation fetcher -> operation)', () => {
    const idx = parseOrvalClients([{ file: 'orders.ts', text: ordersClient }])
    expect(idx.get('getOrdersStoreMutationFetcher')).toEqual({ method: 'POST', path: '/v2/orders' })
    expect(idx.get('useOrdersStore')).toEqual({ method: 'POST', path: '/v2/orders' })
  })

  it('ignores key builders that carry a url but no method', () => {
    const idx = parseOrvalClients([{ file: 'orders.ts', text: ordersClient }])
    expect(idx.has('getOrdersIndexKey')).toBe(false)
    expect(idx.has('getOrdersStoreMutationKey')).toBe(false)
  })

  it('never throws on an unparseable source, returning what it can', () => {
    const idx = parseOrvalClients([
      { file: 'broken.ts', text: 'export const = (' },
      { file: 'orders.ts', text: ordersClient },
    ])
    expect(idx.get('ordersIndex')).toEqual({ method: 'GET', path: '/v2/orders' })
  })
})
