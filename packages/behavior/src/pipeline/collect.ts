import { DATA_FILES, dataPath, writeJsonAtomic } from '@crawl-kit/contract'
import { logger } from '../util/logger.js'
import { STATE_DIR } from '../state/paths.js'
import type {
  RunContext,
  RawPage,
  PageInfo,
  SiteStructure,
  Transition,
  PriorState,
  Feedback,
  TargetEnv,
} from '../domain/types.js'
import type { Scenario } from '../scenario/schema.js'
import type { BrowserLike } from '../services/browser/crawler.js'
import type { NavEdge } from '../services/browser/discover.js'

// --- Injectable dependency interfaces ---

type StoreApi = {
  loadBaseline: (root: string) => Promise<SiteStructure | null>
  saveBaseline: (root: string, s: SiteStructure) => Promise<void>
  loadLatestReport: (root: string) => Promise<SiteStructure | null>
  loadFeedback: (root: string) => Promise<Feedback[]>
  saveRunStructure: (root: string, runId: string, s: SiteStructure) => Promise<void>
}

type CrawlFn = (
  browser: BrowserLike,
  target: TargetEnv,
  scenarios: Scenario[],
  screenshotDir: string,
  /** Optional sink for navigation edges discovered during BFS (see services/browser/discover.ts). */
  onEdge?: (edge: NavEdge) => void,
) => Promise<RawPage[]>

type ExtractPageInfoFn = (llm: unknown, raw: RawPage) => Promise<PageInfo>

export type CollectDeps = {
  store: StoreApi
  crawl: CrawlFn
  extractPageInfo: ExtractPageInfoFn
  /** Optional browser instance; if null/omitted, crawling is skipped (returns empty page list) */
  browser?: BrowserLike | null
  /** Optional LLM instance; if not provided, extractPageInfo won't be called with one */
  llm?: unknown
  /** Screenshot output directory (default: <root>/<STATE_DIR>/runs/<runId>/screenshots) */
  screenshotDir?: string
  /** Scenarios to guide crawl navigation (default: []) */
  scenarios?: Scenario[]
}

export type CollectResult = {
  structure: SiteStructure
  prior: PriorState
  /** Raw pages from the crawler — threaded into the verify stage for security/layout analysis */
  rawPages: RawPage[]
  /** Navigation edges (link/click) discovered during BFS — always populated (possibly empty). */
  edges: NavEdge[]
}

/**
 * The collect pipeline stage:
 * 1. Load prior state (baseline, feedback)
 * 2. Detect first run (baseline absent)
 * 3. Crawl the target site
 * 4. Extract structured PageInfo for each page via LLM
 * 5. Assemble SiteStructure
 * 6. Persist run snapshot; save baseline on first run
 *
 * All external dependencies (store, crawl, extractPageInfo) are injected
 * to enable clean unit testing without real I/O.
 */
export async function collect(ctx: RunContext, deps: CollectDeps): Promise<CollectResult> {
  const { root, runId, config } = ctx
  const { store, crawl, extractPageInfo, browser = null, llm = null } = deps
  const screenshotDir =
    deps.screenshotDir ?? `${root}/${STATE_DIR}/runs/${runId}/screenshots`

  // 1. Load prior state
  const [baseline, latestReport, feedback] = await Promise.all([
    store.loadBaseline(root),
    store.loadLatestReport(root),
    store.loadFeedback(root),
  ])

  const isFirstRun = baseline === null
  logger.info({ runId, isFirstRun }, 'Starting collect pipeline')

  const prior: PriorState = {
    baseline,
    latestReport,
    feedback,
  }

  // 2. Build TargetEnv from config (first target for now)
  // Guard: config.targets[0] used to be dereferenced bare here, which threw an opaque
  // "Cannot read properties of undefined" TypeError when targets was empty (e.g. a
  // freshly-scaffolded workspace whose WorkspaceConfigSchema defaults targets to []).
  // Fail loudly with an actionable message instead — mirrors the CLI's own
  // `!selectedTarget` guard (cli/index.ts) that rejects an empty target list up front.
  if (config.targets.length === 0) {
    throw new Error(
      'targets が未設定です — workspace.yaml / e2e.config.yaml に targets を記載してください',
    )
  }
  const configTarget = config.targets[0]
  const target: TargetEnv = {
    name: configTarget.name,
    baseUrl: configTarget.baseUrl,
    auth: configTarget.auth
      ? {
          strategy: configTarget.auth.strategy,
          loginPath: configTarget.auth.loginPath,
          username: configTarget.auth.usernameEnv
            ? ctx.secrets.targetAuth[configTarget.auth.usernameEnv]
            : undefined,
          password: configTarget.auth.passwordEnv
            ? ctx.secrets.targetAuth[configTarget.auth.passwordEnv]
            : undefined,
        }
      : undefined,
  }

  // 3. Crawl — skip if no browser is available (returns empty page list)
  // Pass deps.scenarios so the crawler can follow scenario step navigation targets.
  // onEdge collects the navigation graph (link/click) that BFS discovery enqueues, threaded into
  // CollectResult.edges and persisted below alongside the other run outputs.
  const edges: NavEdge[] = []
  const rawPages: RawPage[] = browser !== null
    ? await crawl(browser, target, deps.scenarios ?? [], screenshotDir, (edge) => edges.push(edge))
    : []
  logger.info({ pageCount: rawPages.length, edgeCount: edges.length }, 'Crawl complete')

  // 4. Extract PageInfo for each page
  const pages: PageInfo[] = await Promise.all(
    rawPages.map((raw) => extractPageInfo(llm, raw)),
  )

  // 5. Build transitions from the visit sequence (each consecutive pair is a transition)
  const transitions: Transition[] = rawPages.length > 1
    ? rawPages.slice(1).map((page, i) => ({
        fromUrl: rawPages[i]!.url,
        toUrl: page.url,
        trigger: 'navigate',
      }))
    : []

  // 6. Assemble SiteStructure
  const structure: SiteStructure = {
    generatedAt: new Date().toISOString(),
    pages,
    transitions,
  }

  // 7. Persist
  await store.saveRunStructure(root, runId, structure)
  logger.debug({ runId }, 'Run structure saved')

  if (isFirstRun) {
    await store.saveBaseline(root, structure)
    logger.info({ runId }, 'First run — baseline saved')
  }

  // Persist navigation edges on the crawl-kit spine (data/behavior.edges.json) — resolved against
  // this run's root so it lands in the same workspace/repo as the other spine artifacts. Best-effort:
  // a write failure here shouldn't fail the whole collect stage.
  //
  // Skip the write entirely when no browser was available: `edges` is unconditionally `[]` in
  // that case (crawl was never attempted, not "crawled and found nothing"), so writing it would
  // silently clobber a real edges.json from a prior browser-backed run with an empty one.
  if (browser !== null) {
    try {
      await writeJsonAtomic(dataPath(DATA_FILES.behaviorEdges, root), { runId, edges })
    } catch (error) {
      logger.warn({ error, runId }, 'Failed to persist behavior.edges.json')
    }
  } else {
    logger.debug({ runId }, 'collect: no browser — skipping behavior.edges.json write to avoid clobbering existing edges')
  }

  return { structure, prior, rawPages, edges }
}
