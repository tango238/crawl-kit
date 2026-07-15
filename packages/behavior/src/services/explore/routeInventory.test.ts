import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRoutesText, filterRoutes, loadRouteInventory } from './routeInventory.js'

describe('parseRoutesText', () => {
  it('parses OpenAPI paths, one entry per HTTP method', () => {
    const text = JSON.stringify({
      paths: {
        '/orders': { get: {}, post: {} },
        '/orders/{id}': { get: {}, delete: {}, parameters: [] },
      },
    })
    expect(parseRoutesText(text)).toEqual([
      { method: 'GET', path: '/orders' },
      { method: 'POST', path: '/orders' },
      { method: 'GET', path: '/orders/{id}' },
      { method: 'DELETE', path: '/orders/{id}' },
    ])
  })

  it('prefixes OpenAPI paths with the first server url\'s base path (real requests hit base+path)', () => {
    const text = JSON.stringify({
      servers: [{ url: 'https://api.example.com/api' }, { url: 'https://staging.example.com/other' }],
      paths: { '/v2/plans': { get: {} } },
    })
    expect(parseRoutesText(text)).toEqual([{ method: 'GET', path: '/api/v2/plans' }])
  })

  it('handles a relative OpenAPI server url and a bare-origin server url', () => {
    expect(parseRoutesText(JSON.stringify({ servers: [{ url: '/api' }], paths: { '/x': { get: {} } } })))
      .toEqual([{ method: 'GET', path: '/api/x' }])
    expect(parseRoutesText(JSON.stringify({ servers: [{ url: 'https://api.example.com' }], paths: { '/x': { get: {} } } })))
      .toEqual([{ method: 'GET', path: '/x' }])
    expect(parseRoutesText(JSON.stringify({ paths: { '/x': { get: {} } } })))
      .toEqual([{ method: 'GET', path: '/x' }])
  })

  it('parses Laravel route:list json, splitting method and dropping HEAD/OPTIONS', () => {
    const text = JSON.stringify([
      { method: 'GET|HEAD', uri: 'orders' },
      { method: 'POST', uri: 'orders' },
      { method: 'OPTIONS', uri: 'health' },
    ])
    expect(parseRoutesText(text)).toEqual([
      { method: 'GET', path: '/orders' },
      { method: 'POST', path: '/orders' },
    ])
  })

  it('parses a JSON string array of "METHOD /path"', () => {
    expect(parseRoutesText(JSON.stringify(['GET /orders', 'POST /orders/new']))).toEqual([
      { method: 'GET', path: '/orders' },
      { method: 'POST', path: '/orders/new' },
    ])
  })

  it('parses plain text lines, skipping blanks and #-comments', () => {
    const text = '# routes\nGET /orders\n\nPOST /orders\n  DELETE /orders/1  \n'
    expect(parseRoutesText(text)).toEqual([
      { method: 'GET', path: '/orders' },
      { method: 'POST', path: '/orders' },
      { method: 'DELETE', path: '/orders/1' },
    ])
  })

  it('throws when the text is valid JSON but of no known shape', () => {
    expect(() => parseRoutesText(JSON.stringify({ nope: true }))).toThrow(/no recognized routes shape/)
    expect(() => parseRoutesText(JSON.stringify([1, 2, 3]))).toThrow(/no recognized routes shape/)
  })
})

describe('filterRoutes', () => {
  const routes = [
    { method: 'GET', path: '/orders' },
    { method: 'GET', path: '/orders/1' },
    { method: 'GET', path: '/admin/users' },
    { method: 'GET', path: 'health' },
  ]

  it('returns all when include is empty/undefined', () => {
    expect(filterRoutes(routes)).toHaveLength(4)
    expect(filterRoutes(routes, [])).toHaveLength(4)
  })

  it('keeps only routes under an include prefix (leading slash normalized both sides)', () => {
    expect(filterRoutes(routes, ['orders']).map((r) => r.path)).toEqual(['/orders', '/orders/1'])
  })

  it('lets exclude win over include', () => {
    expect(filterRoutes(routes, ['/orders'], ['/orders/1']).map((r) => r.path)).toEqual(['/orders'])
  })
})

describe('loadRouteInventory', () => {
  it('reads cfg.file, filters, normalizes keys, dedupes, and sorts', async () => {
    const readFile = async () => 'GET /orders/123\nGET /orders/456\nPOST /orders'
    const inv = await loadRouteInventory('/root', { file: 'routes.txt' }, { readFile })
    expect(inv?.source).toBe('file')
    // /orders/123 and /orders/456 both normalize to GET /orders/:id → deduped to one (first wins);
    // sorted by raw path, so '/orders' precedes '/orders/123'.
    expect(inv?.routes).toEqual([
      { key: 'POST /orders', method: 'POST', path: '/orders' },
      { key: 'GET /orders/:id', method: 'GET', path: '/orders/123' },
    ])
  })

  it('runs cfg.command and parses its stdout', async () => {
    const exec = async () => JSON.stringify([{ method: 'GET|HEAD', uri: 'ping' }])
    const inv = await loadRouteInventory('/root', { command: 'php artisan route:list --json' }, { exec })
    expect(inv?.source).toBe('command')
    expect(inv?.routes).toEqual([{ key: 'GET /ping', method: 'GET', path: '/ping' }])
  })

  it('propagates parse errors for an explicitly configured file', async () => {
    const readFile = async () => JSON.stringify({ nope: true })
    await expect(loadRouteInventory('/root', { file: 'x.json' }, { readFile })).rejects.toThrow(/no recognized/)
  })

  it('falls back to structure.nodes.json under <root>/data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inv-'))
    await mkdir(join(root, 'data'), { recursive: true })
    await writeFile(
      join(root, 'data', 'structure.nodes.json'),
      JSON.stringify([
        { nodeId: 'structure:route/GET /orders/:id', route: 'GET /orders/:id' },
        { nodeId: 'structure:entity/order', localName: 'order' },
        { nodeId: 'structure:route/POST /orders', route: 'POST /orders' },
      ]),
    )
    const inv = await loadRouteInventory(root, undefined)
    expect(inv?.source).toBe('structure')
    // sorted by raw path: '/orders' precedes '/orders/:id'
    expect(inv?.routes.map((r) => r.key)).toEqual(['POST /orders', 'GET /orders/:id'])
  })

  it('falls back to structure.routes.partial.json when nodes are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inv-'))
    await mkdir(join(root, 'data'), { recursive: true })
    await writeFile(
      join(root, 'data', 'structure.routes.partial.json'),
      JSON.stringify([{ method: 'get', path: '/health' }]),
    )
    const inv = await loadRouteInventory(root, undefined)
    expect(inv?.source).toBe('structure')
    expect(inv?.routes).toEqual([{ key: 'GET /health', method: 'GET', path: '/health' }])
  })

  it('returns null when no config and no fallback files exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inv-'))
    expect(await loadRouteInventory(root, undefined)).toBeNull()
  })
})
