// Per-run explore session log: the recorded request/response traffic of one run, grouped by the
// screen it fired from, saved as both machine JSON and human-readable Markdown. The JSON also
// doubles as the replay source for the next run (which re-visits the recorded screens). Pure
// builder + renderer, thin IO on top. Bodies are pretty-printed when they parse as JSON, otherwise
// kept verbatim; undefined stays undefined (never coerced to null) so the shape round-trips.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeRoute } from '@crawl-kit/reconciler'
import { logger } from '../../util/logger.js'
import { statePaths } from '../../state/paths.js'
import type { ApiTransaction } from '../../domain/transaction.js'

export type SessionTx = {
  seq: number
  ts: string
  method: string
  path: string
  url: string
  routeKey: string
  status?: number
  ok: boolean
  requestQuery?: Record<string, string>
  requestBody?: string
  responseBody?: string
}
export type SessionScreen = { screen: string; txs: SessionTx[] }
export type ExploreSession = {
  runId: string
  startedAt: string
  target: { name: string; baseUrl: string }
  screens: string[]
  pages: SessionScreen[]
}

const NO_PAGE = '(no-page)'
const BODY_RENDER_CAP = 4000

/** Framework dev-server chatter that would drown the real API traffic in the session log
 *  (Next.js HMR/devtools, Vite client). Full fidelity stays in .e2e/runs/<runId>.transactions.jsonl. */
const SESSION_NOISE_PATHS: RegExp[] = [/^\/_next(\/|$)/, /^\/__nextjs/, /^\/@vite(\/|$)/, /^\/__vite/]

/** Is this tx dev-server noise the human-readable session log should skip? */
export function isSessionNoise(path: string): boolean {
  return SESSION_NOISE_PATHS.some((re) => re.test(path))
}

/** The screen a tx belongs to: the owning page's pathname when parseable, else the raw pageUrl. */
function screenOf(pageUrl: string | undefined): string {
  if (!pageUrl) return NO_PAGE
  try {
    return new URL(pageUrl).pathname
  } catch {
    return pageUrl
  }
}

/** Pretty-print a body when it is JSON; summarize markup documents (full text lives in the
 *  transactions jsonl); return anything else unchanged. */
function prettyBody(body: string | undefined): string | undefined {
  if (body == null) return undefined
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    if (/^\s*</.test(body)) return `(HTML/XML ボディ省略 — ${body.length} bytes。全文は .e2e/runs/<runId>.transactions.jsonl)`
    return body
  }
}

function toSessionTx(tx: ApiTransaction): SessionTx {
  return {
    seq: tx.seq,
    ts: tx.ts,
    method: tx.method,
    path: tx.path,
    url: tx.url,
    routeKey: normalizeRoute(`${tx.method} ${tx.path}`),
    status: tx.status,
    ok: tx.ok,
    requestQuery: tx.requestQuery,
    requestBody: prettyBody(tx.requestBody),
    responseBody: prettyBody(tx.responseBody),
  }
}

/**
 * Group this run's transactions into per-screen buckets (screen = owning-page pathname; txs
 * without a page fall under `(no-page)`), preserving first-appearance order of screens and seq
 * order of txs within each screen.
 */
export function buildSession(args: {
  runId: string
  startedAt: string
  target: { name: string; baseUrl: string }
  screens: string[]
  txs: ApiTransaction[]
}): ExploreSession {
  const order: string[] = []
  const byScreen = new Map<string, ApiTransaction[]>()
  for (const tx of args.txs) {
    if (isSessionNoise(tx.path)) continue
    const screen = screenOf(tx.pageUrl)
    if (!byScreen.has(screen)) {
      byScreen.set(screen, [])
      order.push(screen)
    }
    byScreen.get(screen)!.push(tx)
  }

  const pages: SessionScreen[] = order.map((screen) => ({
    screen,
    txs: [...byScreen.get(screen)!].sort((a, b) => a.seq - b.seq).map(toSessionTx),
  }))

  return { runId: args.runId, startedAt: args.startedAt, target: args.target, screens: args.screens, pages }
}

/** Cap a rendered body, appending a marker when truncated (the JSON file keeps the full text). */
function capForRender(body: string): string {
  return body.length <= BODY_RENDER_CAP ? body : `${body.slice(0, BODY_RENDER_CAP)}\n…(truncated)`
}

function jsonBlock(label: string, value: unknown): string[] {
  return [`${label}:`, '', '```json', capForRender(typeof value === 'string' ? value : JSON.stringify(value, null, 2)), '```', '']
}

/** Render a session as Markdown: per-screen sections, each tx with a collapsible req/res block. */
export function renderSessionMarkdown(session: ExploreSession): string {
  const lines: string[] = [`# 探索セッション ${session.runId}`, '']
  lines.push(`- target: ${session.target.name} (${session.target.baseUrl})`)
  lines.push(`- 開始: ${session.startedAt}`)
  lines.push(`- 画面: ${session.screens.join(', ')}`, '')

  for (const page of session.pages) {
    lines.push(`## 画面: ${page.screen}`, '')
    for (const tx of page.txs) {
      lines.push(`### ${tx.method} ${tx.path} → ${tx.status ?? '-'}`, '')
      lines.push('<details><summary>リクエスト/レスポンス</summary>', '')
      if (tx.requestQuery) lines.push(...jsonBlock('requestQuery', tx.requestQuery))
      if (tx.requestBody != null) lines.push(...jsonBlock('requestBody', tx.requestBody))
      if (tx.responseBody != null) lines.push(...jsonBlock('responseBody', tx.responseBody))
      lines.push('</details>', '')
    }
  }
  return lines.join('\n')
}

/** Persist a session as `<runId>.json` + `<runId>.md`, plus `latest.json` for cheap lookup. */
export async function saveSession(root: string, session: ExploreSession): Promise<void> {
  const dir = statePaths(root).exploreSessions
  await mkdir(dir, { recursive: true })
  const json = `${JSON.stringify(session, null, 2)}\n`
  await writeFile(join(dir, `${session.runId}.json`), json, 'utf8')
  await writeFile(join(dir, `${session.runId}.md`), renderSessionMarkdown(session), 'utf8')
  await writeFile(join(dir, 'latest.json'), json, 'utf8')
}

/** Load the most recent session (latest.json); null when missing, and null+warn when corrupt. */
export async function loadLatestSession(root: string): Promise<ExploreSession | null> {
  const path = join(statePaths(root).exploreSessions, 'latest.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(text) as ExploreSession
  } catch (err) {
    logger.warn({ err: String(err), path }, 'session: corrupt latest.json — ignoring')
    return null
  }
}
