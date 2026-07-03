import { describe, it, expect } from 'vitest'
import { summarizeTransactions, renderTransactionSection } from './txSummary.js'
import type { ApiTransaction } from '../domain/transaction.js'

const tx = (o: Partial<ApiTransaction>): ApiTransaction => ({
  runId: 'r', seq: 0, ts: 't', durationMs: 0, stage: 'explore', method: 'GET',
  url: 'http://a/x', path: '/x', resourceType: 'fetch', ok: true, status: 200, ...o,
})

describe('summarizeTransactions', () => {
  it('counts total and per-method, collects failures', () => {
    const s = summarizeTransactions([
      tx({ method: 'GET', status: 200, ok: true }),
      tx({ method: 'POST', status: 201, ok: true }),
      tx({ method: 'POST', status: 500, ok: false }),
      tx({ method: 'DELETE', failed: true, ok: false }),
    ])
    expect(s.total).toBe(4)
    expect(s.byMethod).toEqual({ GET: 1, POST: 2, DELETE: 1 })
    expect(s.failures).toHaveLength(2)
  })
})

describe('renderTransactionSection', () => {
  it('returns empty string for no transactions', () => {
    expect(renderTransactionSection([], 'x')).toBe('')
  })
  it('renders a header, counts, and a failure table', () => {
    const md = renderTransactionSection(
      [tx({ method: 'POST', path: '/api/o', status: 500, ok: false })],
      '.e2e/runs/r.transactions.jsonl',
    )
    expect(md).toContain('## API 通信ログ')
    expect(md).toContain('POST')
    expect(md).toContain('500')
    expect(md).toContain('.e2e/runs/r.transactions.jsonl')
  })
})
