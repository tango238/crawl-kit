// Phase 4 display check: the ScreenSpec knows which fields a screen SHOULD display (from the
// primary GET endpoint's response schema); after visiting the real screen we verify the labeled
// ones actually appear. Only labeled displays are checked — a response FIELD name (e.g. `name`)
// rarely appears verbatim in rendered HTML, but its LABEL does; unlabeled fields would only
// produce false positives.

import { logger } from '../../util/logger.js'
import { waitForClientRender } from '../browser/render.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv, VerifyFinding } from '../../domain/types.js'
import type { ScreenSpec } from './spec.js'

/**
 * Visit a (concrete) screen and report labeled display fields that are missing from the rendered
 * HTML. Templated screens (`:id`) are skipped — there is no concrete URL to visit. Best-effort:
 * navigation/read failures return [] (the crawl already reports unreachable screens).
 */
export async function checkDisplays(
  page: PageLike,
  target: TargetEnv,
  spec: ScreenSpec,
  screenPath: string,
): Promise<VerifyFinding[]> {
  const labeled = spec.displays.filter((d) => d.label && d.label.trim().length > 0)
  if (labeled.length === 0 || screenPath.includes(':')) return []

  const base = target.baseUrl.replace(/\/$/, '')
  const url = /^https?:\/\//i.test(screenPath) ? screenPath : `${base}${screenPath.startsWith('/') ? '' : '/'}${screenPath}`
  let html: string
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('networkidle')
    await waitForClientRender(page)
    html = await page.content()
  } catch (err) {
    logger.warn({ err: String(err), screen: screenPath }, 'display check: screen failed to load — skipping')
    return []
  }

  const findings: VerifyFinding[] = []
  for (const d of labeled) {
    if (html.includes(d.label as string)) continue
    findings.push({
      category: 'layout',
      severity: 'low',
      title: `表示項目未確認: ${screenPath} 「${d.label}」`,
      detail:
        `画面仕様(ScreenSpec)ではフィールド ${d.field} がラベル「${d.label}」で表示されるはずですが、` +
        `${screenPath} の描画結果に見つかりませんでした。表示条件・権限・実装漏れのいずれかを確認してください。`,
      evidence: `screen-spec displays: field=${d.field} label=${d.label}`,
    })
  }
  return findings
}
