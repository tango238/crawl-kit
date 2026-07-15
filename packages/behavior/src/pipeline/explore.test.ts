import { describe, it, expect, vi } from 'vitest'
import { explore } from './explore.js'
import type { ExploreDeps } from './explore.js'
import type { DiscoveredForm, FieldConstraint, InputCase, CaseOutcome, Baseline } from '../services/explore/types.js'
import type { PageLike } from '../services/browser/crawler.js'

const form: DiscoveredForm = {
  screenPath: '/user/create',
  submitSelector: '#submit',
  fields: [{ name: 'age', selector: '#age', htmlType: 'number' }],
}
const constraint: FieldConstraint = { field: 'age', selector: '#age', required: true, type: 'integer', min: 0, table: 'users', column: 'age', evidence: 'e' }
const gapCase: InputCase = { field: 'age', selector: '#age', value: '-1', expectation: 'reject', rationale: 'below min', table: 'users', column: 'age' }

function fakePage(): PageLike {
  return {
    url: () => 'http://app/user/create',
    title: async () => 'x',
    content: async () => '<form></form>',
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    screenshot: async () => {},
    locator: () => ({ fill: async () => {}, click: async () => {}, count: async () => 1 }),
    close: async () => {},
  }
}

function baseDeps(overrides: Partial<ExploreDeps> = {}): ExploreDeps {
  const writeFindings = vi.fn(async () => {})
  const seedDatabase = vi.fn(async () => {})
  return {
    target: { name: 't', baseUrl: 'http://app', auth: { strategy: 'form', loginPath: '/login' } },
    creds: { username: 'u', password: 'p' },
    dbType: 'postgres',
    seed: { command: 'seed-cmd' },
    createPage: async () => fakePage(),
    authenticate: async () => ({ ok: true, detail: 'ok', finalUrl: 'http://app/' }),
    discoverForms: async () => [form],
    inferCandidateTables: async () => ['users'],
    introspectTable: async () => [],
    modelConstraints: async () => [constraint],
    generateCases: async () => [gapCase],
    buildBaseline: () => ({ '#age': '5' }) as Baseline,
    runCase: async () => ({ errorsShown: [], submitStatus: 200, navigatedAway: true, finalUrl: 'http://app/user/1' }) as CaseOutcome,
    classifyGap: async () => ({ gap: true, confidence: 'high' }),
    classifyErrorQuality: async () => [],
    wasValueSaved: async () => true,
    llm: {} as ExploreDeps['llm'],
    writeFindings,
    seedDatabase,
    ...overrides,
  }
}

describe('explore pipeline', () => {
  it('produces a high input-validation finding for a confirmed gap and re-seeds', async () => {
    const deps = baseDeps()
    const res = await explore('/root', { screens: ['/user/create'] }, deps)
    expect(res.gapsHigh).toBe(1)
    expect(res.findings.some((f) => f.category === 'input-validation' && f.severity === 'high')).toBe(true)
    expect(deps.writeFindings).toHaveBeenCalledOnce()
    expect(deps.seedDatabase).toHaveBeenCalledOnce()
  })

  it('aborts (throws) before executing cases when auth fails — no reseed, no report', async () => {
    const runCase = vi.fn(async () => ({ errorsShown: [], navigatedAway: false, finalUrl: 'x' }) as CaseOutcome)
    const deps = baseDeps({
      authenticate: async () => ({ ok: false, detail: 'bad creds', finalUrl: 'http://app/login' }),
      runCase,
    })
    await expect(explore('/root', { screens: ['/user/create'] }, deps)).rejects.toThrow(/auth/i)
    expect(runCase).not.toHaveBeenCalled()
    expect(deps.writeFindings).not.toHaveBeenCalled()
    expect(deps.seedDatabase).not.toHaveBeenCalled()
  })

  it('skips re-seed when noReseed is set', async () => {
    const deps = baseDeps()
    await explore('/root', { screens: ['/user/create'], noReseed: true }, deps)
    expect(deps.seedDatabase).not.toHaveBeenCalled()
  })

  it('throws a guard error when no seed is configured and reseed is not disabled', async () => {
    const deps = baseDeps({ seed: undefined })
    await expect(explore('/root', { screens: ['/user/create'] }, deps)).rejects.toThrow(/seed/i)
  })

  it('runs prepare before discovery unless skipped', async () => {
    const prepare = vi.fn(async () => {})
    const deps = baseDeps({ prepare, config: { setup: [], repositories: [] } as never })
    await explore('/root', { screens: ['/user/create'] }, deps)
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('isolates a per-form modeling failure and still reports', async () => {
    const deps = baseDeps({ modelConstraints: async () => { throw new Error('llm down') } })
    const res = await explore('/root', { screens: ['/user/create'] }, deps)
    expect(res.forms).toBe(1)
    expect(res.cases).toBe(0)
    expect(deps.writeFindings).toHaveBeenCalledOnce()
    expect(deps.seedDatabase).toHaveBeenCalledOnce()
  })

  it('expands screenPrefixes via the injected dep and dedups against explicit screens (explicit first)', async () => {
    const discoverForms = vi.fn(async () => [form])
    const expandScreenPrefixes = vi.fn(async () => ['/orders', '/orders/new', '/user/create'])
    const deps = baseDeps({ discoverForms, expandScreenPrefixes })
    await explore('/root', { screens: ['/user/create'], screenPrefixes: ['/orders'] }, deps)
    expect(expandScreenPrefixes).toHaveBeenCalledWith(expect.anything(), deps.target, ['/orders'])
    expect(discoverForms).toHaveBeenCalledWith(expect.anything(), deps.target, ['/user/create', '/orders', '/orders/new'])
  })

  it('leaves screens unchanged when screenPrefixes is empty, even with the dep provided', async () => {
    const discoverForms = vi.fn(async () => [form])
    const expandScreenPrefixes = vi.fn(async () => ['/orders'])
    const deps = baseDeps({ discoverForms, expandScreenPrefixes })
    await explore('/root', { screens: ['/user/create'] }, deps)
    expect(expandScreenPrefixes).not.toHaveBeenCalled()
    expect(discoverForms).toHaveBeenCalledWith(expect.anything(), deps.target, ['/user/create'])
  })

  it('leaves screens unchanged when screenPrefixes is set but no expandScreenPrefixes dep is provided', async () => {
    const discoverForms = vi.fn(async () => [form])
    const deps = baseDeps({ discoverForms })
    await explore('/root', { screens: ['/user/create'], screenPrefixes: ['/orders'] }, deps)
    expect(discoverForms).toHaveBeenCalledWith(expect.anything(), deps.target, ['/user/create'])
  })

  const session = {
    runId: 'prev-run',
    startedAt: '2026-07-14T00:00:00.000Z',
    target: { name: 't', baseUrl: 'http://app' },
    screens: ['/orders', '/user/create'],
    pages: [],
  }
  const tx = {
    runId: 'r', seq: 0, ts: '2026-07-15T00:00:00.000Z', durationMs: 0, stage: 'explore' as const,
    method: 'GET', url: 'http://app/api/orders', path: '/api/orders', resourceType: 'fetch',
    status: 200, ok: true, pageUrl: 'http://app/orders',
  }
  const inventory = { source: 'file' as const, routes: [{ key: 'GET /api/orders', method: 'GET', path: '/api/orders' }] }

  it('replays the previous session\'s screens into explore targets (deduped, after explicit)', async () => {
    const discoverForms = vi.fn(async () => [form])
    const deps = baseDeps({ discoverForms, loadLatestSession: async () => session })
    await explore('/root', { screens: ['/user/create'] }, deps)
    expect(discoverForms).toHaveBeenCalledWith(expect.anything(), deps.target, ['/user/create', '/orders'])
  })

  it('skips session replay when noReplay is set', async () => {
    const discoverForms = vi.fn(async () => [form])
    const loadLatestSession = vi.fn(async () => session)
    const deps = baseDeps({ discoverForms, loadLatestSession })
    await explore('/root', { screens: ['/user/create'], noReplay: true }, deps)
    expect(loadLatestSession).not.toHaveBeenCalled()
    expect(discoverForms).toHaveBeenCalledWith(expect.anything(), deps.target, ['/user/create'])
  })

  it('records coverage from the run\'s transactions and returns the summary', async () => {
    const summary = { total: 1, covered: 1, newlyCovered: 1, ratio: 1 }
    const saveCoverage = vi.fn(async () => summary)
    const deps = baseDeps({
      loadRouteInventory: async () => inventory,
      getTransactions: () => [tx],
      saveCoverage,
    })
    const res = await explore('/root', { screens: ['/user/create'] }, deps)
    expect(saveCoverage).toHaveBeenCalledWith('/root', inventory, [tx], expect.any(String))
    expect(res.coverage).toEqual(summary)
  })

  it('saves the session with the resolved screens and recorded transactions', async () => {
    const saveSession = vi.fn(async () => {})
    const deps = baseDeps({ getTransactions: () => [tx], saveSession })
    await explore('/root', { screens: ['/user/create'] }, deps)
    expect(saveSession).toHaveBeenCalledWith('/root', {
      runId: expect.any(String),
      startedAt: expect.any(String),
      screens: ['/user/create'],
      txs: [tx],
    })
  })

  it('skips coverage (undefined) when no inventory is found, and never fails the run on coverage errors', async () => {
    const saveCoverage = vi.fn(async () => ({ total: 0, covered: 0, newlyCovered: 0, ratio: 0 }))
    const noInv = baseDeps({ loadRouteInventory: async () => null, getTransactions: () => [tx], saveCoverage })
    const res = await explore('/root', { screens: ['/user/create'] }, noInv)
    expect(saveCoverage).not.toHaveBeenCalled()
    expect(res.coverage).toBeUndefined()

    const throwing = baseDeps({
      loadRouteInventory: async () => { throw new Error('route list unavailable') },
      getTransactions: () => [tx],
      saveCoverage,
    })
    const res2 = await explore('/root', { screens: ['/user/create'] }, throwing)
    expect(res2.coverage).toBeUndefined()
    expect(res2.forms).toBe(1)
  })

  it('does not save a session when no transactions were recorded', async () => {
    const saveSession = vi.fn(async () => {})
    const deps = baseDeps({ getTransactions: () => [], saveSession })
    await explore('/root', { screens: ['/user/create'] }, deps)
    expect(saveSession).not.toHaveBeenCalled()
  })
})
