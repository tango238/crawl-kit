/** One recorded same-origin API request/response, persisted as one jsonl line. */
export type ApiTransaction = {
  runId: string
  seq: number
  ts: string
  durationMs: number
  stage: RecordStage
  method: string
  url: string
  path: string
  resourceType: string
  requestQuery?: Record<string, string>
  requestBody?: string
  requestBodyTruncated?: boolean
  status?: number
  statusText?: string
  responseBody?: string
  responseBodyTruncated?: boolean
  ok: boolean
  failed?: boolean
  errorText?: string
  /** Origin+pathname of the page the request fired from (its owning screen), when obtainable
   *  and same-origin. The join key for cross-referencing this tx to the sitemap/screen views.
   *  Page-level only — NOT the exact click/link that triggered it (out of scope). */
  pageUrl?: string
}

export type RecordStage = 'crawl' | 'explore' | 'scenario' | 'login' | 'crud'
export const DEFAULT_BODY_CAP_BYTES = 32768
export const TRANSACTIONS_SUFFIX = '.transactions.jsonl'
