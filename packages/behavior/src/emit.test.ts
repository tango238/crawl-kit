import { describe, expect, it } from 'vitest'
import { emitBehaviorAll, emitBehaviorTransitionNodes, emitTransactionNodes } from './emit.js'
import type { SiteStructure } from './domain/types.js'
import type { ApiTransaction } from './domain/transaction.js'
import type { CrudResultsLike } from './tx-persistence.js'

const tx = (over: Partial<ApiTransaction>): ApiTransaction => ({
  runId: 'r', seq: 0, ts: '2026-07-01T00:00:00Z', durationMs: 0, stage: 'explore',
  method: 'POST', url: 'http://app.test/api/orders', path: '/api/orders',
  resourceType: 'fetch', ok: true, status: 201, ...over,
})

describe('emitTransactionNodes', () => {
  it('emits a method-keyed behavior node for a mutating request', () => {
    const nodes = emitTransactionNodes([tx({})], 'r')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].route).toBe('POST /api/orders')
    expect(nodes[0].layer).toBe('behavior')
    expect(nodes[0].nodeId.startsWith('behavior:tx/')).toBe(true)
    expect((nodes[0].raw as Record<string, unknown>).method).toBe('POST')
  })
  it('ignores GET transactions (pages already cover navigations)', () => {
    expect(emitTransactionNodes([tx({ method: 'GET' })], 'r')).toHaveLength(0)
  })
  it('fills raw.saved from savedByRoute (CRUD executor feedback)', () => {
    const nodes = emitTransactionNodes([tx({})], 'r', { 'POST /api/orders': ['title'] })
    expect((nodes[0]!.raw as Record<string, unknown>).saved).toEqual(['title'])
  })
  it('emits ONE node per mutating tx (no route dedup) with a seq-unique nodeId', () => {
    const nodes = emitTransactionNodes([tx({ seq: 1 }), tx({ seq: 2 })], 'r')
    expect(nodes).toHaveLength(2)
    // both normalize to the SAME route (the reconciler join key), distinct nodeIds via #seq
    expect(nodes.map((n) => n.route)).toEqual(['POST /api/orders', 'POST /api/orders'])
    expect(nodes.map((n) => n.nodeId)).toEqual(['behavior:tx/POST /api/orders#1', 'behavior:tx/POST /api/orders#2'])
    expect(nodes[0]!.seq).toBe(1)
    expect(nodes[1]!.seq).toBe(2)
  })

  it('same-route mutations each carry the (route-derived) persisted verdict', () => {
    const crudResults: CrudResultsLike = [
      {
        entity: 'orders',
        route: 'POST /api/orders',
        savedColumns: ['title'],
        steps: [{ step: 'create', route: 'POST /api/orders', ok: true, detail: 'saved title', dbProbed: true }],
      },
    ]
    const nodes = emitTransactionNodes([tx({ seq: 1 }), tx({ seq: 2 })], 'r', undefined, crudResults)
    expect(nodes).toHaveLength(2)
    expect(nodes.every((n) => n.persisted === 'yes')).toBe(true)
    expect(nodes.every((n) => n.route === 'POST /api/orders')).toBe(true)
  })

  it('does NOT explode non-mutating GET traffic into per-tx nodes (still 0, deduped as today)', () => {
    const nodes = emitTransactionNodes(
      [tx({ method: 'GET', seq: 1 }), tx({ method: 'GET', seq: 2 })],
      'r',
    )
    expect(nodes).toHaveLength(0)
  })

  it('carries a persisted verdict from crudResults (oracle success)', () => {
    const crudResults: CrudResultsLike = [
      {
        entity: 'orders',
        route: 'POST /api/orders',
        savedColumns: ['title'],
        steps: [{ step: 'create', route: 'POST /api/orders', ok: true, detail: 'saved title', dbProbed: true }],
      },
    ]
    const nodes = emitTransactionNodes([tx({})], 'r', undefined, crudResults)
    expect(nodes[0]!.persisted).toBe('yes')
  })

  it('carries "unknown" when crudResults has no matching probe for the mutation', () => {
    const crudResults: CrudResultsLike = []
    const nodes = emitTransactionNodes([tx({})], 'r', undefined, crudResults)
    expect(nodes[0]!.persisted).toBe('unknown')
  })

  it('carries "unknown" (not "yes") when the matching step is status-only (dbProbed:false)', () => {
    const crudResults: CrudResultsLike = [
      {
        entity: 'orders',
        route: 'POST /api/orders',
        savedColumns: [],
        steps: [{ step: 'create', route: 'POST /api/orders', ok: true, detail: 'status 201 (DB未接続で status のみ)', dbProbed: false }],
      },
    ]
    const nodes = emitTransactionNodes([tx({})], 'r', undefined, crudResults)
    expect(nodes[0]!.persisted).toBe('unknown')
  })

  it('omits persisted when no crudResults were supplied at all (undefined)', () => {
    const nodes = emitTransactionNodes([tx({})], 'r')
    expect(nodes[0]!.persisted).toBeUndefined()
  })

  it('omits persisted when crudResults is explicitly null (no CRUD artifact for this run)', () => {
    const nodes = emitTransactionNodes([tx({})], 'r', undefined, null)
    expect(nodes[0]!.persisted).toBeUndefined()
  })
})

const structure: SiteStructure = {
  generatedAt: '2026-06-28T00:00:00Z',
  pages: [
    {
      url: 'https://app.test/orders',
      title: 'Orders',
      description: 'order list',
      displayItems: [],
      inputItems: [],
      expectations: [],
      capabilities: ['create order'],
    },
  ],
  transitions: [{ fromUrl: 'https://app.test/orders', toUrl: 'https://app.test/orders/new', trigger: 'click New' }],
}

describe('emitBehaviorTransitionNodes', () => {
  it('emits a behavior:transition node per observed navigation', () => {
    const [node] = emitBehaviorTransitionNodes(structure, 'run-1')
    expect(node?.nodeId).toBe('behavior:transition/orders--orders-new')
    expect(node?.layer).toBe('behavior')
    const raw = node?.raw as { kind: string; from: string; to: string; trigger: string }
    expect(raw.kind).toBe('transition')
    expect(raw.from).toBe('/orders')
    expect(raw.to).toBe('/orders/new')
    expect(raw.trigger).toBe('click New')
    expect(node?.source.runId).toBe('run-1')
  })
})

describe('emitBehaviorAll', () => {
  it('combines page nodes and transition nodes', () => {
    const nodes = emitBehaviorAll(structure)
    expect(nodes.some((n) => n.nodeId.startsWith('behavior:page/'))).toBe(true)
    expect(nodes.some((n) => n.nodeId.startsWith('behavior:transition/'))).toBe(true)
  })

  it('threads crudResults through to the behavior:tx/ node persisted verdict', () => {
    const crudResults: CrudResultsLike = [
      {
        entity: 'orders',
        route: 'POST /api/orders',
        savedColumns: [],
        steps: [{ step: 'create', route: 'POST /api/orders', ok: false, detail: 'not persisted', dbProbed: true }],
      },
    ]
    const nodes = emitBehaviorAll(structure, null, 'r', [tx({})], undefined, crudResults)
    const txNode = nodes.find((n) => n.nodeId.startsWith('behavior:tx/'))
    expect(txNode?.persisted).toBe('no')
  })

  it('emitBehaviorAll passes null crudResults through untouched (no persisted annotation)', () => {
    const nodes = emitBehaviorAll(structure, null, 'r', [tx({})], undefined, null)
    const txNode = nodes.find((n) => n.nodeId.startsWith('behavior:tx/'))
    expect(txNode?.persisted).toBeUndefined()
  })
})
