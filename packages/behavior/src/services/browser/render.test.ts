import { describe, it, expect, vi } from 'vitest'
import { waitForClientRender } from './render.js'

const shell = '<html><head><title>app</title></head><body><div id="__next"></div></body></html>'

describe('waitForClientRender', () => {
  it('returns immediately when links are already present (zero cost for SSR pages)', async () => {
    const content = vi.fn(async () => '<html><body><a href="/x">x</a></body></html>')
    await waitForClientRender({ content })
    expect(content).toHaveBeenCalledTimes(1)
  })

  it('returns immediately when a form is present (login/search screens without links)', async () => {
    const content = vi.fn(async () => '<html><body><form><input name="q"></form></body></html>')
    await waitForClientRender({ content })
    expect(content).toHaveBeenCalledTimes(1)
  })

  it('waits out an empty CSR shell until hydration renders links', async () => {
    let serves = 0
    const content = vi.fn(async () => {
      serves += 1
      return serves < 3 ? shell : '<html><body><a href="/hotel">h</a></body></html>'
    })
    await waitForClientRender({ content })
    expect(serves).toBe(3) // kept polling past the shell samples
  })

  it('exits once the DOM size is stable for consecutive samples (link-less rendered page)', async () => {
    const content = vi.fn(async () => '<html><body><p>plain page, no links or forms</p></body></html>')
    await waitForClientRender({ content })
    expect(content.mock.calls.length).toBeLessThanOrEqual(4) // stable-size early exit, not maxMs
  })

  it('never throws when content() fails', async () => {
    await expect(
      waitForClientRender({ content: async () => { throw new Error('page closed') } }),
    ).resolves.toBeUndefined()
  })
})
