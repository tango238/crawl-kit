import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSession, renderSessionMarkdown, saveSession, loadLatestSession, isSessionNoise } from './session.js'
import type { ApiTransaction } from '../../domain/transaction.js'

function tx(over: Partial<ApiTransaction>): ApiTransaction {
  return {
    runId: 'r',
    seq: 0,
    ts: '2026-07-15T00:00:00.000Z',
    durationMs: 0,
    stage: 'explore',
    method: 'GET',
    url: 'http://app.test/api/orders',
    path: '/api/orders',
    resourceType: 'fetch',
    status: 200,
    ok: true,
    ...over,
  }
}

const target = { name: 't', baseUrl: 'http://app.test' }

describe('buildSession', () => {
  it('groups txs by owning-page screen (first-appearance order), seq-ordered within a screen', () => {
    const session = buildSession({
      runId: 'run1',
      startedAt: 't0',
      target,
      screens: ['/orders'],
      txs: [
        tx({ seq: 2, pageUrl: 'http://app.test/orders?tab=1', path: '/api/orders/2' }),
        tx({ seq: 0, pageUrl: 'http://app.test/orders', path: '/api/orders' }),
        tx({ seq: 1, pageUrl: 'http://app.test/users', path: '/api/users' }),
      ],
    })
    expect(session.pages.map((p) => p.screen)).toEqual(['/orders', '/users'])
    expect(session.pages[0].txs.map((t) => t.seq)).toEqual([0, 2]) // seq-ordered
  })

  it('groups txs without a pageUrl under (no-page)', () => {
    const session = buildSession({ runId: 'r', startedAt: 't', target, screens: [], txs: [tx({ pageUrl: undefined })] })
    expect(session.pages[0].screen).toBe('(no-page)')
  })

  it('pretty-prints JSON bodies, keeps non-JSON verbatim, and sets the routeKey', () => {
    const session = buildSession({
      runId: 'r',
      startedAt: 't',
      target,
      screens: [],
      txs: [
        tx({ method: 'POST', path: '/api/orders/5', requestBody: '{"a":1}', responseBody: 'not json' }),
      ],
    })
    const t = session.pages[0].txs[0]
    expect(t.routeKey).toBe('POST /api/orders/:id')
    expect(t.requestBody).toBe('{\n  "a": 1\n}')
    expect(t.responseBody).toBe('not json')
  })

  it('leaves undefined body fields undefined (not null)', () => {
    const session = buildSession({ runId: 'r', startedAt: 't', target, screens: [], txs: [tx({ requestBody: undefined })] })
    expect(session.pages[0].txs[0].requestBody).toBeUndefined()
    expect('requestBody' in session.pages[0].txs[0]).toBe(true)
  })

  it('summarizes HTML/XML bodies instead of embedding the markup', () => {
    const html = '<!DOCTYPE html><html><body>big page</body></html>'
    const session = buildSession({ runId: 'r', startedAt: 't', target, screens: [], txs: [tx({ responseBody: html })] })
    const body = session.pages[0].txs[0].responseBody
    expect(body).toContain('ボディ省略')
    expect(body).toContain(`${html.length} bytes`)
    expect(body).not.toContain('<html>')
  })

  it('drops framework dev-server noise from the session (kept in the transactions jsonl)', () => {
    expect(isSessionNoise('/_next/static/chunk.js')).toBe(true)
    expect(isSessionNoise('/__nextjs_original-stack-frame')).toBe(true)
    expect(isSessionNoise('/@vite/client')).toBe(true)
    expect(isSessionNoise('/api/v2/orders')).toBe(false)
    const session = buildSession({
      runId: 'r', startedAt: 't', target, screens: [],
      txs: [tx({ path: '/__nextjs_original-stack-frame' }), tx({ path: '/api/v2/orders', seq: 1 })],
    })
    expect(session.pages.flatMap((p) => p.txs.map((t) => t.path))).toEqual(['/api/v2/orders'])
  })
})

describe('renderSessionMarkdown', () => {
  it('renders headers, per-screen sections, and collapsible request/response blocks', () => {
    const session = buildSession({
      runId: 'run1',
      startedAt: '2026-07-15T00:00:00.000Z',
      target,
      screens: ['/orders'],
      txs: [
        tx({ method: 'POST', path: '/api/orders', status: 201, pageUrl: 'http://app.test/orders', requestBody: '{"a":1}', requestQuery: { q: 'x' } }),
      ],
    })
    const md = renderSessionMarkdown(session)
    expect(md).toContain('# 探索セッション run1')
    expect(md).toContain('- 画面: /orders')
    expect(md).toContain('## 画面: /orders')
    expect(md).toContain('### POST /api/orders → 201')
    expect(md).toContain('<details><summary>リクエスト/レスポンス</summary>')
    expect(md).toContain('requestQuery:')
    expect(md).toContain('```json')
  })

  it('caps a long rendered body with a truncation marker', () => {
    const big = JSON.stringify({ v: 'z'.repeat(6000) })
    const session = buildSession({ runId: 'r', startedAt: 't', target, screens: [], txs: [tx({ responseBody: big })] })
    const md = renderSessionMarkdown(session)
    expect(md).toContain('…(truncated)')
  })
})

describe('session IO round-trip', () => {
  it('writes <runId>.json, <runId>.md and latest.json, and loadLatestSession reads it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sess-'))
    expect(await loadLatestSession(root)).toBeNull()
    const session = buildSession({
      runId: 'run1',
      startedAt: 't',
      target,
      screens: ['/orders'],
      txs: [tx({ pageUrl: 'http://app.test/orders' })],
    })
    await saveSession(root, session)
    const reloaded = await loadLatestSession(root)
    expect(reloaded).toEqual(session)
    const md = await readFile(join(root, '.e2e', 'explore', 'sessions', 'run1.md'), 'utf8')
    expect(md).toContain('# 探索セッション run1')
  })
})
