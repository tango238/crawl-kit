import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '../../util/logger.js'
import { maskSecrets } from '../../util/mask.js'
import { statePaths } from '../../state/paths.js'
import { DEFAULT_BODY_CAP_BYTES, TRANSACTIONS_SUFFIX } from '../../domain/transaction.js'
import type { ApiTransaction, RecordStage } from '../../domain/transaction.js'
import { normalizeUrl } from './discover.js'

export type RecorderOptions = {
  runId: string
  root: string
  baseUrl: string
  secrets: string[]
  bodyCapBytes?: number
}

export type RecResponse = { status(): number; statusText(): string; text(): Promise<string> }
export type RecRequest = {
  url(): string
  method(): string
  resourceType(): string
  postData(): string | null
  failure?(): { errorText: string } | null
  response(): Promise<RecResponse | null>
  /** Playwright's real Request exposes `.frame().url()` — the page the request fired from.
   *  Optional so fake-request-based tests keep compiling; absent/throwing → no page context. */
  frame?(): { url(): string }
}
export type RecorderPage = {
  on(event: 'requestfinished' | 'requestfailed', cb: (req: RecRequest) => void): void
}
export type Recorder = { attach(page: RecorderPage, stage: RecordStage): void; path: string }

const API_TYPES = new Set(['xhr', 'fetch', 'document'])
export function isApiResourceType(t: string): boolean {
  return API_TYPES.has(t)
}

export function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

export function capBody(s: string, cap: number): { body: string; truncated: boolean } {
  if (s.length <= cap) return { body: s, truncated: false }
  return { body: s.slice(0, cap), truncated: true }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

function queryOf(url: string): Record<string, string> | undefined {
  try {
    const q = new URL(url).searchParams
    const out: Record<string, string> = {}
    for (const [k, v] of q) out[k] = v
    return Object.keys(out).length ? out : undefined
  } catch {
    return undefined
  }
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const cap = opts.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES
  const path = join(statePaths(opts.root).runs, `${opts.runId}${TRANSACTIONS_SUFFIX}`)
  let seq = 0
  let ensured = false

  const mask = (s: string): string => maskSecrets(s, opts.secrets)

  async function write(tx: ApiTransaction): Promise<void> {
    try {
      if (!ensured) {
        await mkdir(dirname(path), { recursive: true })
        ensured = true
      }
      await appendFile(path, `${JSON.stringify(tx)}\n`, 'utf8')
    } catch (err) {
      logger.warn({ err: String(err) }, 'recorder: append failed — continuing')
    }
  }

  async function record(req: RecRequest, stage: RecordStage, failed: boolean): Promise<void> {
    try {
      const url = req.url()
      if (!sameOrigin(url, opts.baseUrl)) return
      if (!isApiResourceType(req.resourceType())) return

      const rawReqBody = req.postData() ?? undefined
      const reqCap = rawReqBody != null ? capBody(mask(rawReqBody), cap) : undefined

      let status: number | undefined
      let statusText: string | undefined
      let respCap: { body: string; truncated: boolean } | undefined
      if (!failed) {
        const res = await req.response().catch(() => null)
        if (res) {
          status = res.status()
          statusText = res.statusText()
          const body = await res.text().catch(() => '')
          if (body) respCap = capBody(mask(body), cap)
        }
      }
      const errText = failed ? (req.failure?.() ?? null)?.errorText : undefined

      // Page context: the screen the request fired from. Best-effort — a missing/throwing
      // frame() or a cross-origin frame url leaves pageUrl unset and never breaks recording.
      // Page-level only; NOT edge-level correlation (which exact click/link fired the tx —
      // out of scope, NavEdges and txs share no time axis).
      let pageUrl: string | undefined
      try {
        const frameUrl = req.frame?.().url()
        if (frameUrl && sameOrigin(frameUrl, opts.baseUrl)) pageUrl = normalizeUrl(frameUrl)
      } catch {
        /* frame unavailable — leave pageUrl unset */
      }

      const tx: ApiTransaction = {
        runId: opts.runId,
        seq: seq++,
        ts: new Date().toISOString(),
        durationMs: 0,
        stage,
        method: req.method().toUpperCase(),
        url: mask(url),
        path: pathOf(url),
        resourceType: req.resourceType(),
        requestQuery: queryOf(url),
        requestBody: reqCap?.body,
        requestBodyTruncated: reqCap?.truncated || undefined,
        status,
        statusText,
        responseBody: respCap?.body,
        responseBodyTruncated: respCap?.truncated || undefined,
        ok: status != null ? status >= 200 && status < 400 : false,
        failed: failed || undefined,
        errorText: errText || undefined,
        pageUrl,
      }
      await write(tx)
    } catch (err) {
      logger.warn({ err: String(err) }, 'recorder: record failed — continuing')
    }
  }

  return {
    path,
    attach(page: RecorderPage, stage: RecordStage): void {
      page.on('requestfinished', (req) => void record(req, stage, false))
      page.on('requestfailed', (req) => void record(req, stage, true))
    },
  }
}

/**
 * Wrap a browser-like object so every page it opens has the recorder attached. Needed because
 * the crawler calls `browser.newPage()` internally (it does not go through an injected page
 * factory), so wrapping the browser is the single point that covers all crawl pages.
 */
export function withRecorder<B extends { newPage: () => Promise<unknown>; close: () => Promise<void> }>(
  browser: B,
  recorder: Recorder,
  stage: RecordStage,
): B {
  return {
    ...browser,
    newPage: async () => {
      const page = await browser.newPage()
      try {
        recorder.attach(page as unknown as RecorderPage, stage)
      } catch {
        /* best effort — never block page creation */
      }
      return page
    },
  }
}
