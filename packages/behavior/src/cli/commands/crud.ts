import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { DATA_FILES, dataPath } from '@crawl-kit/contract'
import type { LayerNode } from '@crawl-kit/contract'
import { logger } from '../../util/logger.js'
import { statePaths } from '../../state/paths.js'
import { CRUD_SAVED_SUFFIX, CRUD_RESULTS_SUFFIX } from '../../services/crud/types.js'
import type { ApiClient, CrudEntityResult } from '../../services/crud/types.js'
import type { Config } from '../../config/schema.js'
import type { Secrets, TargetEnv, VerifyFinding } from '../../domain/types.js'
import type { ColumnDef } from '../../services/explore/types.js'
import type { PartialRoute } from '../../services/crud/plan.js'
import type { DbAdapter } from '../../services/db/adapter.js'
import type { BrowserLike, PageLike } from '../../services/browser/crawler.js'
import { createRecorder, withRecorder } from '../../services/browser/recorder.js'

export type RunCrudOpts = { target?: string; noReseed?: boolean }
export type RunCrudResult = { entities: number; findings: number }

export type RunCrudDeps = {
  loadConfig: (cwd: string) => Promise<{ config: Config; secrets: Secrets }>
  createDbAdapter: (conn: Config['databases'][number], password: string) => DbAdapter
  launchBrowser: () => Promise<{ browser: BrowserLike }>
}

function resolveCreds(secrets: Secrets, auth: NonNullable<Config['targets'][number]['auth']>): { username: string; password: string } | null {
  const username = auth.usernameEnv ? secrets.targetAuth[auth.usernameEnv] : undefined
  const password = auth.passwordEnv ? secrets.targetAuth[auth.passwordEnv] : undefined
  if (!username || !password) return null
  return { username, password }
}

/**
 * ApiClient that issues requests via `page.evaluate(fetch)` — i.e. from INSIDE the browser page.
 * This is deliberate: fetch-from-page uses Chromium's network stack (so --host-resolver-rules and
 * self-signed TLS handling apply) and carries the authenticated session cookies, and the calls are
 * seen by the recorder's page 'requestfinished' listener. Playwright's APIRequestContext
 * (page.request) instead uses Node's DNS/TLS and would fail on local vhosts (ENOTFOUND).
 */
function apiClientFromPage(page: PageLike, baseUrl: string): ApiClient {
  const base = baseUrl.replace(/\/$/, '')
  const p = page as unknown as { evaluate: <T>(fn: (arg: { full: string; method: string; body?: unknown }) => T | Promise<T>, arg: { full: string; method: string; body?: unknown }) => Promise<T> }
  return {
    async request(method, url, body) {
      const full = /^https?:\/\//i.test(url) ? url : `${base}/${url.replace(/^\//, '')}`
      const out = await p.evaluate(async (a) => {
        const res = await fetch(a.full, {
          method: a.method,
          headers: a.body !== undefined ? { 'content-type': 'application/json' } : {},
          body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
          credentials: 'include',
        })
        return { status: res.status, text: await res.text() }
      }, { full, method, body })
      return {
        status: out.status,
        json: async () => { try { return JSON.parse(out.text) } catch { return null } },
        text: async () => out.text,
      }
    },
  }
}

/**
 * Drive each entity's CRUD happy-path via API calls against structure's method-keyed routes,
 * verifying persistence/absence in the DB. Destructive → guarded by seed/--no-reseed and reseeds
 * afterward. Writes crud findings to the store and a per-run saved-columns artifact (feeds emit).
 */
export async function runCrud(cwd: string, opts: RunCrudOpts, deps: RunCrudDeps): Promise<RunCrudResult> {
  const { config, secrets } = await deps.loadConfig(cwd)

  // Guard: refuse destructive execution without a restore path.
  if (!config.launch?.seed && !opts.noReseed) {
    throw new Error('crud: launch.seed is not configured and --no-reseed was not passed; aborting to avoid leaving the DB dirty')
  }

  const selected = opts.target ? config.targets.find((t) => t.name === opts.target) : config.targets[0]
  if (!selected) throw new Error(`crud: no matching target${opts.target ? ` "${opts.target}"` : ''} configured`)
  if (!selected.auth || selected.auth.strategy === 'none') throw new Error('crud: target has no form auth configured')
  const creds = resolveCreds(secrets, selected.auth)
  if (!creds) throw new Error('crud: target credentials not configured (usernameEnv/passwordEnv)')

  const target: TargetEnv = {
    name: selected.name,
    baseUrl: selected.baseUrl,
    auth: { strategy: selected.auth.strategy, loginPath: selected.auth.loginPath, loginUrl: selected.auth.loginUrl, username: creds.username, password: creds.password },
  }
  const allSecrets: string[] = [
    secrets.anthropicApiKey,
    secrets.githubToken,
    ...Object.values(secrets.db),
    ...Object.values(secrets.targetAuth),
  ].filter(Boolean) as string[]

  const { authenticate } = await import('../../services/browser/login.js')
  const { introspectTable } = await import('../../services/explore/dbIntrospect.js')
  const { wasValueSaved, wasValueAbsent } = await import('../../services/explore/dbProbe.js')
  const { buildCrudPlans, buildCrudPlansFromPartial, entitiesFromPartial } = await import('../../services/crud/plan.js')
  const { executeCrudPlan } = await import('../../services/crud/execute.js')
  const { writeFindings } = await import('../../state/findings.js')
  const { seedDatabase } = await import('../../services/seed/seed.js')
  const { defaultComposeRunner } = await import('../../services/compose/compose.js')
  const { loadScenarios } = await import('../../scenario/schema.js')
  const { findLoginScenario } = await import('../../scenario/loginScenario.js')

  // The designated login scenario supplies 2FA glue (pinCommand + its script dir).
  const scenarioDirRaw = config.scenarioDir ?? 'scenarios'
  const scenarioDir = scenarioDirRaw.startsWith('/') ? scenarioDirRaw : `${cwd}/${scenarioDirRaw}`
  const loginScenario = findLoginScenario(await loadScenarios(scenarioDir), selected.auth.loginPath)

  const dbConf = config.databases[0]
  const dbType: 'postgres' | 'mysql' = (dbConf?.type as 'postgres' | 'mysql') ?? 'postgres'
  const db = dbConf ? deps.createDbAdapter(dbConf, secrets.db[dbConf.passwordEnv] ?? '') : undefined

  // structure route nodes (method-keyed) from the crawl-kit spine. When full nodes aren't
  // available yet (only Pass 1 of the incremental analyzer has run), fall back to the routes
  // partial so CRUD planning can start; a later full analyze refines it.
  const structureNodes = JSON.parse(await readFile(dataPath(DATA_FILES.structureNodes), 'utf8').catch(() => '[]')) as LayerNode[]
  const hasFullNodes = structureNodes.some((n) => n.nodeId.startsWith('structure:route/'))
  const partialRoutes = hasFullNodes
    ? []
    : (JSON.parse(await readFile(dataPath(DATA_FILES.structureRoutesPartial), 'utf8').catch(() => '[]')) as PartialRoute[])
  if (!hasFullNodes && partialRoutes.length > 0) {
    console.error(`crud: structure.nodes.json 未生成 — routes partial (${partialRoutes.length} routes) から計画します`)
  }

  const { browser } = await deps.launchBrowser()
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  // Record every same-origin API req/res of this crud run to jsonl (masked+capped), mirroring
  // run/explore. apiClientFromPage issues fetch from inside the page, so the recorder's
  // 'requestfinished' listener sees each CRUD POST/GET/PATCH/DELETE. Wrapping the browser is the
  // single point that covers the page opened below.
  const recorder = createRecorder({ runId, root: cwd, baseUrl: target.baseUrl, secrets: allSecrets })
  const recordedBrowser = withRecorder(browser, recorder, 'crud')
  const findings: VerifyFinding[] = []
  const savedByRoute: Record<string, string[]> = {}
  const entityResults: CrudEntityResult[] = []
  try {
    const page = await recordedBrowser.newPage()
    const auth = await authenticate(page, target, creds, {
      pinRunner: defaultComposeRunner,
      secrets: allSecrets,
      twoFactor: loginScenario?.twoFactor,
      scriptDir: loginScenario?.scriptDir,
    })
    if (!auth.ok) throw new Error(`crud: authentication failed (${auth.detail}) — aborting before any write`)

    const api = apiClientFromPage(page, target.baseUrl)

    // Introspect columns for every entity referenced by the routes (full nodes carry the
    // entity; the partial infers it from the path).
    const entities = new Set(
      hasFullNodes
        ? structureNodes
            .filter((n) => n.nodeId.startsWith('structure:route/'))
            .map((n) => (n.raw as { entity?: string } | undefined)?.entity)
            .filter((e): e is string => Boolean(e))
        : entitiesFromPartial(partialRoutes),
    )
    const columnsByTable: Record<string, ColumnDef[]> = {}
    if (db) {
      for (const e of entities) columnsByTable[e] = await introspectTable(db, dbType, e)
    }

    const plans = hasFullNodes
      ? buildCrudPlans(structureNodes, columnsByTable)
      : buildCrudPlansFromPartial(partialRoutes, columnsByTable)
    for (const plan of plans) {
      const { findings: fs, result } = await executeCrudPlan(plan, { api, db, dbType, wasValueSaved, wasValueAbsent })
      findings.push(...fs)
      if (result.savedColumns.length) savedByRoute[result.route] = result.savedColumns
      entityResults.push(result)
    }

    // Persist findings + the saved-columns artifact (emit reads the latter to fill tx `saved`)
    // + the full per-step results (emit reads this to fill tx `persisted` — tx-persistence.ts).
    await writeFindings(cwd, { source: 'explore', runId, startedAt: new Date().toISOString(), diffFindings: [], verifyFindings: findings })
    const savedPath = join(statePaths(cwd).runs, `${runId}${CRUD_SAVED_SUFFIX}`)
    await mkdir(statePaths(cwd).runs, { recursive: true })
    await writeFile(savedPath, `${JSON.stringify(savedByRoute, null, 2)}\n`, 'utf8')
    const resultsPath = join(statePaths(cwd).runs, `${runId}${CRUD_RESULTS_SUFFIX}`)
    await writeFile(resultsPath, `${JSON.stringify(entityResults, null, 2)}\n`, 'utf8')

    // Restore DB unless explicitly skipped.
    if (!opts.noReseed && config.launch?.seed) {
      await seedDatabase(config.launch.seed, cwd, defaultComposeRunner, allSecrets)
    }

    return { entities: plans.length, findings: findings.length }
  } finally {
    await db?.close().catch((err) => logger.warn({ err: String(err) }, 'crud: db close failed'))
    await browser.close().catch(() => {})
  }
}
