import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '@crawl-kit/contract'
import { saveRunStructure } from '../../state/store.js'
import type { SiteStructure } from '../../domain/types.js'
import type { NavEdge } from '../../services/browser/discover.js'
import { runEmit } from './emit.js'

const makeStructure = (): SiteStructure => ({
  generatedAt: '2026-07-03T00:00:00.000Z',
  pages: [
    {
      url: 'https://example.com/',
      title: 'Home',
      description: 'home',
      displayItems: [],
      inputItems: [],
      expectations: [],
      capabilities: [],
    },
    {
      url: 'https://example.com/about',
      title: 'About',
      description: 'about',
      displayItems: [],
      inputItems: [],
      expectations: [],
      capabilities: [],
    },
  ],
  transitions: [],
})

describe('runEmit: behavior.sitemap.json wiring', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-emit-sitemap-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes data/behavior.sitemap.json built from behavior.edges.json when it exists', async () => {
    await saveRunStructure(root, 'run-1', makeStructure())
    const edges: NavEdge[] = [{ from: 'https://example.com/', to: 'https://example.com/about', kind: 'link' }]
    await writeJsonAtomic(join(root, 'data', 'behavior.edges.json'), { runId: 'run-1', edges })

    await runEmit(root)

    const sitemap = JSON.parse(await readFile(join(root, 'data', 'behavior.sitemap.json'), 'utf8'))
    expect(sitemap.roots).toHaveLength(1)
    expect(sitemap.roots[0].url).toBe('https://example.com/')
    expect(sitemap.roots[0].children).toEqual([
      { url: 'https://example.com/about', via: { kind: 'link' }, children: [] },
    ])
    expect(sitemap.orphans).toEqual([])
  })

  it('silently skips writing behavior.sitemap.json when behavior.edges.json is missing', async () => {
    await saveRunStructure(root, 'run-1', makeStructure())

    await expect(runEmit(root)).resolves.toBeDefined()

    await expect(readFile(join(root, 'data', 'behavior.sitemap.json'), 'utf8')).rejects.toThrow()
  })

  it('normalizes page URLs before building the sitemap, so a query-string page URL joins its edge node instead of becoming a false orphan', async () => {
    // The crawled page's url carries a query string (a real finalUrl artifact); the edge, per
    // discover.ts, was recorded already normalizeUrl'd (no query string). Without normalizing
    // the page url the same way, these would be treated as two different nodes and the page
    // would wrongly show up as an orphan.
    const structure: SiteStructure = {
      generatedAt: '2026-07-03T00:00:00.000Z',
      pages: [
        { url: 'https://example.com/', title: 'Home', description: 'home', displayItems: [], inputItems: [], expectations: [], capabilities: [] },
        { url: 'https://example.com/about?ref=nav&utm_source=x', title: 'About', description: 'about', displayItems: [], inputItems: [], expectations: [], capabilities: [] },
      ],
      transitions: [],
    }
    await saveRunStructure(root, 'run-1', structure)
    const edges: NavEdge[] = [{ from: 'https://example.com/', to: 'https://example.com/about', kind: 'link' }]
    await writeJsonAtomic(join(root, 'data', 'behavior.edges.json'), { runId: 'run-1', edges })

    await runEmit(root)

    const sitemap = JSON.parse(await readFile(join(root, 'data', 'behavior.sitemap.json'), 'utf8'))
    expect(sitemap.orphans).toEqual([])
    expect(sitemap.roots).toHaveLength(1)
    expect(sitemap.roots[0].children).toEqual([
      { url: 'https://example.com/about', via: { kind: 'link' }, children: [] },
    ])
  })
})

describe('runEmit: persisted (null vs. absent crud-results artifact)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-emit-persisted-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('does not annotate persisted on tx nodes when no *.crud-results.json artifact exists for the run', async () => {
    const structure: SiteStructure = {
      generatedAt: '2026-07-03T00:00:00.000Z',
      pages: [],
      transitions: [],
    }
    await saveRunStructure(root, 'run-1', structure)

    // A transactions file with one mutating request, but no *.crud-results.json artifact
    // anywhere under .e2e/runs — crud was never run for this run.
    const runsDir = join(root, '.e2e', 'runs')
    await mkdir(runsDir, { recursive: true })
    const tx = {
      runId: 'run-1', seq: 0, ts: '2026-07-03T00:00:00Z', durationMs: 1, stage: 'explore',
      method: 'POST', url: 'https://example.com/api/orders', path: '/api/orders',
      resourceType: 'fetch', ok: true, status: 201,
    }
    await writeFile(join(runsDir, 'run-1.transactions.jsonl'), `${JSON.stringify(tx)}\n`, 'utf8')

    await runEmit(root)

    const nodes = JSON.parse(await readFile(join(root, 'data', 'behavior.nodes.json'), 'utf8'))
    const txNode = nodes.find((n: { nodeId: string }) => n.nodeId.startsWith('behavior:tx/'))
    expect(txNode).toBeDefined()
    expect('persisted' in txNode).toBe(false)
  })
})
