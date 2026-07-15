// CSR-heavy SPAs (e.g. Next.js App Router) can pass 'networkidle' while the client bundle is
// still hydrating — reading page.content() at that instant yields an empty shell (title only,
// zero <a href>/<form>), which starves link expansion and form discovery. Proven against a real
// Next.js admin target: BFS crawl discovery collapsed to a single page on the same pattern.
//
// NOTE: an equivalent uncommitted fix exists for the crawl path (browser/discover.ts capture);
// this module is deliberately a separate file so the two changes never conflict — unify when
// both land.

/** The one page capability this wait needs — satisfied by PageLike. */
type ContentPage = { content(): Promise<string> }

/**
 * Poll page.content() until the DOM looks rendered: links or a form appear, or the HTML size is
 * stable across consecutive samples (static/link-less pages exit after ~600ms). Bounded by
 * maxMs; never throws.
 */
export async function waitForClientRender(page: ContentPage, maxMs = 10_000): Promise<void> {
  const intervalMs = 150
  // A rendered page with legitimately no links/forms exits after this many consecutive
  // same-size samples — long enough to ride out a brief pre-hydration lull, short enough
  // not to tax pages that are simply plain.
  const stableNeeded = 4
  const attempts = Math.max(1, Math.floor(maxMs / intervalMs))
  let prevLen = -1
  let stableCount = 0
  for (let i = 0; i < attempts; i++) {
    let html = ''
    try {
      html = await page.content()
    } catch {
      return
    }
    // Links or a form present → rendered enough for expansion/form discovery; return
    // immediately (zero extra samples for server-rendered pages and hydrated CSR pages).
    if (/<a\s[^>]*\bhref/i.test(html) || /<form[\s>]/i.test(html)) return
    stableCount = html.length === prevLen ? stableCount + 1 : 0
    if (stableCount >= stableNeeded - 1) return
    prevLen = html.length
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
