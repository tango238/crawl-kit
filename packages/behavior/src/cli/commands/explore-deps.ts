import type { ExploreDeps } from '../../pipeline/explore.js'
import type { Config } from '../../config/schema.js'
import type { Secrets, TargetEnv } from '../../domain/types.js'
import type { ApiTransaction } from '../../domain/transaction.js'
import type { PageLike } from '../../services/browser/crawler.js'
import type { Llm } from '../../services/llm/client.js'
import type { FindingsEntry, ActivityEntry } from '../../state/findings.js'

/** Minimal handle onto the shared authenticated browser context — just enough to mint pages. */
export type AuthedContextLike = { newPage: () => Promise<PageLike> }

export type BuildExploreDepsInput = {
  exploreTarget: TargetEnv
  exploreCreds: { username: string; password: string }
  config: Config
  secrets: Secrets
  allSecrets: string[]
  llm: Llm
  writeFindings: (root: string, entry: FindingsEntry) => Promise<void>
  appendActivity?: (root: string, entry: ActivityEntry) => Promise<void>
  /** Lazily establishes (or reuses) the shared authenticated browser context. */
  getAuthedContext: () => Promise<AuthedContextLike>
  /** Attach the run's request/response recorder to a freshly created explore page. */
  attachRecorder: (page: PageLike) => void
  /** This run's recorded transactions so far (from the shared recorder) — feeds route coverage. */
  getTransactions?: () => ApiTransaction[]
}

/**
 * Build the fully-wired `ExploreDeps` for `run --explore`'s exploreState stage. Extracted out of
 * the `cli/index.ts` closure so the wiring is unit-testable — the un-extracted inline version had
 * silently omitted `expandScreenPrefixes`, so `run --explore --screen-prefix` did nothing (the
 * pipeline guard at `pipeline/explore.ts` skips expansion when the dep is absent). Mirrors
 * `cli/commands/explore.ts`'s `runExplore` wiring.
 */
export async function buildExploreDeps(input: BuildExploreDepsInput): Promise<ExploreDeps> {
  const { discoverForms } = await import('../../services/explore/discover.js')
  const { expandScreenPrefixes } = await import('../../services/explore/expand.js')
  const { inferCandidateTables, modelConstraints } = await import('../../services/explore/constraintModel.js')
  const { introspectTable } = await import('../../services/explore/dbIntrospect.js')
  const { generateCases, buildBaseline } = await import('../../services/explore/caseGen.js')
  const { runCase } = await import('../../services/explore/execute.js')
  const { classifyGap, classifyErrorQuality } = await import('../../services/explore/oracle.js')
  const { wasValueSaved } = await import('../../services/explore/dbProbe.js')
  const { createDbAdapter } = await import('../../services/db/index.js')
  const { seedDatabase } = await import('../../services/seed/seed.js')
  const { defaultComposeRunner } = await import('../../services/compose/compose.js')
  const { loadRouteInventory } = await import('../../services/explore/routeInventory.js')
  const { loadCoverageStore, updateCoverage, saveCoverageStore } = await import('../../services/explore/routeCoverage.js')
  const { buildSession, saveSession, loadLatestSession } = await import('../../services/explore/session.js')

  const dbConf = input.config.databases[0]
  const dbType: 'postgres' | 'mysql' = (dbConf?.type as 'postgres' | 'mysql') ?? 'postgres'
  const db = dbConf ? createDbAdapter(dbConf, input.secrets.db[dbConf.passwordEnv] ?? '') : undefined

  let lastStatus: number | undefined
  // Pages come from the SHARED authenticated context, so explore does NOT log in again —
  // its `authenticate` dep is a no-op verifying the already-established session.
  const exCreatePage = async (): Promise<PageLike> => {
    const page = await (await input.getAuthedContext()).newPage()
    const r = page as unknown as {
      on?: (event: 'response', cb: (res: { status: () => number; request: () => { method: () => string } }) => void) => void
    }
    r.on?.('response', (res) => {
      try {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(res.request().method().toUpperCase())) lastStatus = res.status()
      } catch { /* ignore */ }
    })
    input.attachRecorder(page)
    return page
  }

  return {
    target: input.exploreTarget,
    creds: input.exploreCreds,
    dbType,
    seed: input.config.launch?.seed,
    config: input.config,
    secrets: input.allSecrets,
    execDeps: { secrets: input.allSecrets, getLastStatus: () => lastStatus },
    createPage: exCreatePage,
    // Session already established by the shared context; just confirm it.
    authenticate: async () => ({ ok: true, detail: 'reusing shared authenticated session', finalUrl: input.exploreTarget.baseUrl }),
    discoverForms: (page, t, screens) => discoverForms(page, t, screens),
    expandScreenPrefixes: (page, t, prefixes) => expandScreenPrefixes(page, t, prefixes),
    // Route coverage + session save/replay — mirrors cli/commands/explore.ts's wiring. The
    // transactions come from run's SHARED recorder (collect/login/explore stages all count:
    // any observed operation covers its route).
    loadRouteInventory: (root) => loadRouteInventory(root, input.config.explore?.routes),
    getTransactions: input.getTransactions,
    loadLatestSession,
    saveCoverage: async (root, inventory, txs, coverageRunId) => {
      const prev = await loadCoverageStore(root)
      const { store, summary } = updateCoverage(prev, inventory, txs, coverageRunId, new Date().toISOString())
      await saveCoverageStore(root, store)
      return summary
    },
    saveSession: async (root, args) => {
      await saveSession(root, buildSession({
        ...args,
        target: { name: input.exploreTarget.name, baseUrl: input.exploreTarget.baseUrl },
      }))
    },
    inferCandidateTables,
    introspectTable,
    modelConstraints,
    generateCases,
    buildBaseline,
    runCase,
    classifyGap,
    classifyErrorQuality,
    wasValueSaved,
    db,
    llm: input.llm,
    writeFindings: input.writeFindings,
    appendActivity: input.appendActivity,
    // Required by ExploreDeps; unused here because run calls explore with noReseed:true (run owns
    // the final reseed).
    seedDatabase: (seed, root, s) => seedDatabase(seed, root, defaultComposeRunner, s),
  }
}
