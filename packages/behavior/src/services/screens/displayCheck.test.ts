import { describe, it, expect, vi } from 'vitest'
import { checkDisplays } from './displayCheck.js'
import type { ScreenSpec } from './spec.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv } from '../../domain/types.js'

const target: TargetEnv = { name: 't', baseUrl: 'http://app.test' }

const spec = (displays: ScreenSpec['displays']): ScreenSpec => ({
  screen: '/orders',
  analyzedAt: 't',
  uses: [{ method: 'GET', path: '/orders' }],
  displays,
})

function pageWith(html: string): PageLike {
  return {
    goto: vi.fn(async () => {}),
    url: () => 'http://app.test/orders',
    title: async () => 't',
    content: async () => html,
    evaluate: async () => ({}),
    screenshot: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({ fill: async () => {}, click: async () => {} }),
  } as unknown as PageLike
}

describe('checkDisplays', () => {
  it('reports a labeled display field missing from the rendered HTML', async () => {
    const page = pageWith('<html><body><table><th>注文番号</th></table></body></html>')
    const findings = await checkDisplays(
      page,
      target,
      spec([
        { field: 'number', label: '注文番号' },
        { field: 'total', label: '合計金額' },
      ]),
      '/orders',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ category: 'layout', severity: 'low' })
    expect(findings[0].title).toContain('合計金額')
  })

  it('reports nothing when every labeled field renders, and ignores unlabeled fields', async () => {
    const page = pageWith('<html><body><th>注文番号</th></body></html>')
    const findings = await checkDisplays(
      page,
      target,
      spec([{ field: 'number', label: '注文番号' }, { field: 'internal_code' }]),
      '/orders',
    )
    expect(findings).toEqual([])
  })

  it('skips templated screens (no concrete URL to visit)', async () => {
    const page = pageWith('')
    const findings = await checkDisplays(page, target, spec([{ field: 'x', label: 'ラベル' }]), '/orders/:id')
    expect(findings).toEqual([])
    expect(page.goto).not.toHaveBeenCalled()
  })

  it('returns [] when the screen fails to load (best-effort)', async () => {
    const page = pageWith('')
    ;(page.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'))
    const findings = await checkDisplays(page, target, spec([{ field: 'x', label: 'ラベル' }]), '/orders')
    expect(findings).toEqual([])
  })
})
