import type { ApiTransaction } from '../domain/transaction.js'

export type TxSummary = { total: number; byMethod: Record<string, number>; failures: ApiTransaction[] }

export function summarizeTransactions(txs: ApiTransaction[]): TxSummary {
  const byMethod: Record<string, number> = {}
  const failures: ApiTransaction[] = []
  for (const t of txs) {
    byMethod[t.method] = (byMethod[t.method] ?? 0) + 1
    if (!t.ok) failures.push(t)
  }
  return { total: txs.length, byMethod, failures }
}

/** Deterministic Markdown section (no LLM → no secrets in prompts). '' if empty. */
export function renderTransactionSection(txs: ApiTransaction[], jsonlRef: string): string {
  if (txs.length === 0) return ''
  const s = summarizeTransactions(txs)
  const methods = Object.entries(s.byMethod)
    .sort()
    .map(([m, n]) => `${m} ${n}`)
    .join(' / ')
  const failRows = s.failures
    .map((f) => `| ${f.method} | ${f.path} | ${f.status ?? (f.failed ? 'FAILED' : '-')} | ${f.stage} |`)
    .join('\n')
  const failTable = s.failures.length
    ? `\n\n**失敗 (${s.failures.length})**\n\n| method | path | status | stage |\n|---|---|---|---|\n${failRows}`
    : '\n\nすべて成功（非2xxなし）。'
  return `\n\n## API 通信ログ\n\n- 総リクエスト: ${s.total}\n- method 別: ${methods}\n- 生ログ: \`${jsonlRef}\`${failTable}`
}
