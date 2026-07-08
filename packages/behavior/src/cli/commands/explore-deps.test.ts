import { describe, it, expect, vi } from 'vitest'
import { buildExploreDeps } from './explore-deps.js'
import type { Config } from '../../config/schema.js'
import type { Secrets, TargetEnv } from '../../domain/types.js'
import type { PageLike } from '../../services/browser/crawler.js'

describe('buildExploreDeps', () => {
  it('wires expandScreenPrefixes, discoverForms, and runCase onto the ExploreDeps object', async () => {
    const config = { databases: [], targets: [] } as unknown as Config
    const secrets = { db: {}, targetAuth: {}, anthropicApiKey: '', githubToken: '' } as unknown as Secrets
    const target: TargetEnv = { name: 't', baseUrl: 'https://app.test' }
    const page = {} as PageLike

    const deps = await buildExploreDeps({
      exploreTarget: target,
      exploreCreds: { username: 'u', password: 'p' },
      targetName: 't',
      config,
      secrets,
      allSecrets: [],
      llm: {} as never,
      writeFindings: vi.fn(async () => {}),
      appendActivity: vi.fn(async () => {}),
      getAuthedContext: async () => ({ newPage: async () => page }),
      attachRecorder: vi.fn(),
    })

    // Pinning the wiring: run --explore silently dropped screen-prefix expansion because
    // this closure never set expandScreenPrefixes on the ExploreDeps it built (see explore.ts's
    // guard at `deps.expandScreenPrefixes &&`). This test would have failed against that bug.
    expect(typeof deps.expandScreenPrefixes).toBe('function')
    expect(typeof deps.discoverForms).toBe('function')
    expect(typeof deps.runCase).toBe('function')
    expect(deps.target).toBe(target)
    expect(deps.creds).toEqual({ username: 'u', password: 'p' })
  })

  it('createPage tracks the last mutating-request status via execDeps.getLastStatus', async () => {
    const config = { databases: [], targets: [] } as unknown as Config
    const secrets = { db: {}, targetAuth: {}, anthropicApiKey: '', githubToken: '' } as unknown as Secrets
    const target: TargetEnv = { name: 't', baseUrl: 'https://app.test' }

    let responseCb: ((res: { status: () => number; request: () => { method: () => string } }) => void) | undefined
    const page: PageLike = {
      url: () => 'https://app.test',
      title: async () => 'x',
      content: async () => '<html></html>',
      goto: async () => {},
      waitForLoadState: async () => {},
      evaluate: async () => ({}),
      screenshot: async () => {},
      locator: () => ({ fill: async () => {}, click: async () => {}, count: async () => 0 }),
    } as PageLike
    ;(page as unknown as { on: typeof responseCb extends undefined ? never : (event: 'response', cb: NonNullable<typeof responseCb>) => void }).on =
      ((_event: 'response', cb: NonNullable<typeof responseCb>) => { responseCb = cb }) as never

    const deps = await buildExploreDeps({
      exploreTarget: target,
      exploreCreds: { username: 'u', password: 'p' },
      targetName: 't',
      config,
      secrets,
      allSecrets: [],
      llm: {} as never,
      writeFindings: vi.fn(async () => {}),
      appendActivity: vi.fn(async () => {}),
      getAuthedContext: async () => ({ newPage: async () => page }),
      attachRecorder: vi.fn(),
    })

    await deps.createPage()
    expect(responseCb).toBeTypeOf('function')
    responseCb?.({ status: () => 201, request: () => ({ method: () => 'POST' }) })
    expect(deps.execDeps?.getLastStatus?.()).toBe(201)
  })
})
