import { describe, it, expect } from 'vitest'
import { matchPrefixLinks, expandScreenPrefixes } from './expand.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv } from '../../domain/types.js'

const baseUrl = 'https://app.test'

describe('matchPrefixLinks', () => {
  it('matches same-origin links under the prefix with segment-boundary, in first-occurrence order, deduped', () => {
    const html = `
      <a href="/orders/new">New</a>
      <a href="/orders/123/edit">Edit</a>
      <a href="/orders-archive">Archive</a>
      <a href="/users">Users</a>
      <a href="https://app.test/orders/9">Nine</a>
      <a href="https://evil.test/orders/1">Evil</a>
      <a href="mailto:someone@example.com">Mail</a>
      <a href="#frag">Fragment-only</a>
      <a href="/orders/new">New again (dup)</a>
    `
    const result = matchPrefixLinks(html, baseUrl, '/orders')
    expect(result).toEqual(['/orders/new', '/orders/123/edit', '/orders/9'])
  })

  it('preserves the query string', () => {
    const html = '<a href="/orders/edit?id=1">Edit</a>'
    const result = matchPrefixLinks(html, baseUrl, '/orders')
    expect(result).toContain('/orders/edit?id=1')
  })

  it('matches the prefix path itself', () => {
    const html = '<a href="/orders">Self</a>'
    expect(matchPrefixLinks(html, baseUrl, '/orders')).toEqual(['/orders'])
  })

  it('normalizes a bare prefix (no leading slash) the same as its slash-prefixed form', () => {
    const html = '<a href="/orders/new">New</a><a href="/users">Users</a>'
    expect(matchPrefixLinks(html, baseUrl, 'orders')).toEqual(matchPrefixLinks(html, baseUrl, '/orders'))
    expect(matchPrefixLinks(html, baseUrl, 'orders')).toEqual(['/orders/new'])
  })

  it('normalizes a trailing-slash prefix to its bare form', () => {
    const html = '<a href="/orders">Self</a><a href="/orders/new">New</a>'
    expect(matchPrefixLinks(html, baseUrl, '/orders/')).toEqual(['/orders', '/orders/new'])
  })

  it('accepts an absolute same-origin URL prefix, matching by its pathname', () => {
    const html = '<a href="/orders/new">New</a><a href="/users">Users</a>'
    expect(matchPrefixLinks(html, baseUrl, 'https://app.test/orders')).toEqual(['/orders/new'])
  })
})

function fakePage(htmlByPath: Record<string, string>, throwFor: Set<string> = new Set()): PageLike {
  let url = `${baseUrl}/`
  return {
    url: () => url,
    title: async () => 'x',
    content: async () => htmlByPath[new URL(url).pathname] ?? '<html></html>',
    goto: async (u: string) => {
      const path = new URL(u).pathname
      if (throwFor.has(path)) throw new Error(`boom: ${path}`)
      url = u
    },
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    screenshot: async () => {},
    locator: () => ({ fill: async () => {}, click: async () => {}, count: async () => 0 }),
  }
}

describe('expandScreenPrefixes', () => {
  it('returns the prefix itself first, then its matched links', async () => {
    const page = fakePage({ '/orders': '<a href="/orders/new">New</a><a href="/users">Users</a>' })
    const target: TargetEnv = { name: 't', baseUrl }
    const result = await expandScreenPrefixes(page, target, ['/orders'])
    expect(result).toEqual(['/orders', '/orders/new'])
  })

  it('tolerates a prefix page that fails to load, keeping just its own path', async () => {
    const page = fakePage(
      { '/orders': '<a href="/orders/new">New</a>' },
      new Set(['/broken']),
    )
    const target: TargetEnv = { name: 't', baseUrl }
    const result = await expandScreenPrefixes(page, target, ['/orders', '/broken'])
    expect(result).toEqual(['/orders', '/orders/new', '/broken'])
  })

  it('dedups across prefixes', async () => {
    const page = fakePage({
      '/orders': '<a href="/orders/new">New</a>',
      '/orders/new': '<a href="/orders/new">Self-link</a>',
    })
    const target: TargetEnv = { name: 't', baseUrl }
    const result = await expandScreenPrefixes(page, target, ['/orders', '/orders/new'])
    expect(result).toEqual(['/orders', '/orders/new'])
  })

  it('normalizes a bare prefix (no leading slash) like its slash-prefixed form', async () => {
    const page = fakePage({ '/orders': '<a href="/orders/new">New</a><a href="/users">Users</a>' })
    const target: TargetEnv = { name: 't', baseUrl }
    const result = await expandScreenPrefixes(page, target, ['orders'])
    expect(result).toEqual(['/orders', '/orders/new'])
  })

  it('a trailing-slash prefix yields a single self entry (no /orders/ + /orders duplicate)', async () => {
    const page = fakePage({ '/orders': '<a href="/orders">Self</a><a href="/orders/new">New</a>' })
    const target: TargetEnv = { name: 't', baseUrl }
    const result = await expandScreenPrefixes(page, target, ['/orders/'])
    expect(result).toEqual(['/orders', '/orders/new'])
  })

  it('an absolute URL prefix contributes its pathname (no junk /https:// entry) and matches links', async () => {
    const page = fakePage({ '/orders': '<a href="/orders/new">New</a><a href="/users">Users</a>' })
    const target: TargetEnv = { name: 't', baseUrl }
    const result = await expandScreenPrefixes(page, target, ['https://app.test/orders'])
    expect(result).toEqual(['/orders', '/orders/new'])
  })
})
