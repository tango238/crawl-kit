import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecorder, withRecorder, sameOrigin, isApiResourceType, capBody } from './recorder.js'
import type { ApiTransaction } from '../../domain/transaction.js'

type Cb = (req: any) => void

function fakePage() {
  const handlers: Record<string, Cb[]> = { requestfinished: [], requestfailed: [] }
  return {
    on: (e: 'requestfinished' | 'requestfailed', cb: Cb) => handlers[e].push(cb),
    emitFinished: (req: any) => handlers.requestfinished.forEach((h) => h(req)),
    emitFailed: (req: any) => handlers.requestfailed.forEach((h) => h(req)),
  }
}

function req(over: Partial<any>) {
  return {
    url: () => 'http://app.test/api/orders',
    method: () => 'POST',
    resourceType: () => 'fetch',
    postData: () => '{"name":"x"}',
    failure: () => null,
    response: async () => ({ status: () => 201, statusText: () => 'Created', text: async () => '{"id":1}' }),
    ...over,
  }
}

async function lines(path: string): Promise<ApiTransaction[]> {
  const txt = await readFile(path, 'utf8').catch(() => '')
  return txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

describe('recorder helpers', () => {
  it('sameOrigin matches host+scheme, ignores path', () => {
    expect(sameOrigin('http://app.test/api/x', 'http://app.test')).toBe(true)
    expect(sameOrigin('http://other.test/x', 'http://app.test')).toBe(false)
  })
  it('isApiResourceType allows xhr/fetch/document only', () => {
    expect(isApiResourceType('fetch')).toBe(true)
    expect(isApiResourceType('xhr')).toBe(true)
    expect(isApiResourceType('document')).toBe(true)
    expect(isApiResourceType('image')).toBe(false)
    expect(isApiResourceType('stylesheet')).toBe(false)
  })
  it('capBody truncates over the cap and flags it', () => {
    const r = capBody('abcdef', 3)
    expect(r).toEqual({ body: 'abc', truncated: true })
    expect(capBody('ab', 3)).toEqual({ body: 'ab', truncated: false })
  })
})

describe('createRecorder', () => {
  it('records a same-origin API POST with masked+capped bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'run1', root, baseUrl: 'http://app.test', secrets: ['topsecret'], bodyCapBytes: 1000 })
    const page = fakePage()
    rec.attach(page as any, 'explore')
    page.emitFinished(req({ postData: () => '{"pw":"topsecret"}' }))
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows).toHaveLength(1)
    expect(rows[0].method).toBe('POST')
    expect(rows[0].path).toBe('/api/orders')
    expect(rows[0].status).toBe(201)
    expect(rows[0].ok).toBe(true)
    expect(rows[0].stage).toBe('explore')
    expect(rows[0].requestBody).not.toContain('topsecret')
    expect(rows[0].requestBody).toContain('***')
  })

  it('collects each recorded tx in memory, returning a copy from transactions()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'mem', root, baseUrl: 'http://app.test', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'explore')
    page.emitFinished(req({ url: () => 'http://app.test/api/orders', method: () => 'POST' }))
    page.emitFinished(req({ url: () => 'http://app.test/api/orders/1', method: () => 'GET', postData: () => null }))
    await new Promise((r) => setTimeout(r, 10))
    const txs = rec.transactions()
    expect(txs).toHaveLength(2)
    expect(txs.map((t) => t.path)).toEqual(['/api/orders', '/api/orders/1'])
    // returned array is a copy — mutating it does not affect the collector
    txs.pop()
    expect(rec.transactions()).toHaveLength(2)
  })

  it('skips static assets and cross-origin requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'r', root, baseUrl: 'http://app.test', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'crawl')
    page.emitFinished(req({ resourceType: () => 'image', url: () => 'http://app.test/logo.png' }))
    page.emitFinished(req({ url: () => 'http://cdn.other/x.js', resourceType: () => 'fetch' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(await lines(rec.path)).toHaveLength(0)
  })

  it('settle() drains in-flight response handlers so the snapshot includes late traffic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'late', root, baseUrl: 'http://app.test', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'explore')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    page.emitFinished(req({
      response: async () => {
        await gate // response body still streaming
        return { status: () => 200, statusText: () => 'OK', text: async () => '{}' }
      },
    }))
    expect(rec.transactions()).toHaveLength(0) // naive sync snapshot misses the in-flight tx
    release()
    await rec.settle()
    expect(rec.transactions()).toHaveLength(1)
  })

  it('records requests to configured extraOrigins (SPA calling an API on another origin)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({
      runId: 'r', root, baseUrl: 'https://admin.app.test', extraOrigins: ['https://api.app.test'], secrets: [],
    })
    const page = fakePage()
    rec.attach(page as any, 'explore')
    page.emitFinished(req({
      url: () => 'https://api.app.test/api/v2/plans',
      method: () => 'GET',
      postData: () => null,
      frame: () => ({ url: () => 'https://admin.app.test/plans' }),
    }))
    page.emitFinished(req({ url: () => 'https://unrelated.test/x', resourceType: () => 'fetch' }))
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows).toHaveLength(1)
    expect(rows[0].path).toBe('/api/v2/plans')
    // pageUrl stays baseUrl-scoped: the owning screen is the SPA page
    expect(rows[0].pageUrl).toBe('https://admin.app.test/plans')
  })

  it('records a failed request with failed=true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'r', root, baseUrl: 'http://app.test', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'scenario')
    page.emitFailed(req({ failure: () => ({ errorText: 'net::ERR_ABORTED' }), response: async () => null }))
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows[0].failed).toBe(true)
    expect(rows[0].ok).toBe(false)
    expect(rows[0].errorText).toBe('net::ERR_ABORTED')
  })
})

describe('withRecorder', () => {
  it('attaches the recorder to every page the wrapped browser opens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'wrap', root, baseUrl: 'http://app.test', secrets: [] })
    let closed = false
    const browser = {
      newPage: async () => fakePage() as unknown,
      close: async () => { closed = true },
    }
    const wrapped = withRecorder(browser, rec, 'crawl')
    const page = (await wrapped.newPage()) as ReturnType<typeof fakePage>
    page.emitFinished(req({}))
    await new Promise((r) => setTimeout(r, 10))
    expect(await lines(rec.path)).toHaveLength(1)
    await wrapped.close()
    expect(closed).toBe(true)
  })

  it('stamps the normalized owning page URL from req.frame().url()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'pg1', root, baseUrl: 'https://app.example', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'crud')
    page.emitFinished(
      req({
        url: () => 'https://app.example/api/orders',
        frame: () => ({ url: () => 'https://app.example/orders/new?draft=1#top' }),
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows).toHaveLength(1)
    expect(rows[0].pageUrl).toBe('https://app.example/orders/new')
  })

  it('records fine with no pageUrl when frame is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'pg2', root, baseUrl: 'http://app.test', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'explore')
    page.emitFinished(req({})) // fake req has no frame
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows).toHaveLength(1)
    expect(rows[0].pageUrl).toBeUndefined()
  })

  it('leaves pageUrl unset when the frame url is cross-origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'pg3', root, baseUrl: 'http://app.test', secrets: [] })
    const page = fakePage()
    rec.attach(page as any, 'crud')
    page.emitFinished(req({ frame: () => ({ url: () => 'https://evil.other/orders/new' }) }))
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows).toHaveLength(1)
    expect(rows[0].pageUrl).toBeUndefined()
  })

  it("records CRUD API traffic under the 'crud' stage", async () => {
    const root = await mkdtemp(join(tmpdir(), 'rec-'))
    const rec = createRecorder({ runId: 'crud1', root, baseUrl: 'http://app.test', secrets: [] })
    const browser = {
      newPage: async () => fakePage() as unknown,
      close: async () => {},
    }
    const wrapped = withRecorder(browser, rec, 'crud')
    const page = (await wrapped.newPage()) as ReturnType<typeof fakePage>
    page.emitFinished(req({ method: () => 'PATCH', url: () => 'http://app.test/api/orders/1' }))
    await new Promise((r) => setTimeout(r, 10))
    const rows = await lines(rec.path)
    expect(rows).toHaveLength(1)
    expect(rows[0].stage).toBe('crud')
    expect(rows[0].method).toBe('PATCH')
  })
})
