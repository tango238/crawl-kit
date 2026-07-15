// Orchestrate static screen analysis: turn a list of frontend routes into ScreenSpecs. No browser,
// no LLM. For each screen we locate its App Router page, walk its import graph two hops deep (page →
// barrels → components), find which orval client symbols appear, and from the matched endpoints
// derive `uses`, the first mutation's `submits` (with deterministic values), and the primary GET's
// `displays`. Per-screen failures are logged and skipped — one broken page never sinks the batch.

import { join, dirname } from 'node:path'
import { readFile as fsReadFile, readdir as fsReaddir } from 'node:fs/promises'
import { logger } from '../../util/logger.js'
import { parseOrvalClients, type EndpointRef, type HookIndex } from './orval.js'
import {
  parseZodObject,
  requestSchemaNameFor,
  responseSchemaNameFor,
  type FieldConstraintSpec,
} from './zodParse.js'
import { valueForField } from './values.js'
import type { ScreenSpec, ScreenSpecInput } from './spec.js'

/** A directory entry, abstracted so the filesystem can be injected in tests. */
export type DirEntry = { name: string; isDirectory: boolean }
export type AnalyzeDeps = {
  readFile?: (p: string) => Promise<string>
  readDir?: (p: string) => Promise<DirEntry[]>
}

const PAGE_NAMES = ['page.tsx', 'page.ts', 'page.jsx', 'page.js']
const SOURCE_EXTS = ['.tsx', '.ts', '.jsx', '.js']
const IMPORT_DEPTH = 2

const defaultReadFile = (p: string): Promise<string> => fsReadFile(p, 'utf8')
const defaultReadDir = async (p: string): Promise<DirEntry[]> =>
  (await fsReaddir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))

/** Read a file, returning null instead of throwing when it is missing/unreadable. */
async function tryRead(readFile: (p: string) => Promise<string>, path: string): Promise<string | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

/** Recursively list files under `dir` (returns absolute paths); a missing dir yields []. */
async function walkFiles(readDir: (p: string) => Promise<DirEntry[]>, dir: string): Promise<string[]> {
  let entries: DirEntry[]
  try {
    entries = await readDir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory) out.push(...(await walkFiles(readDir, full)))
    else out.push(full)
  }
  return out
}

/**
 * Map every App Router page to its URL route. Route-group segments (`(dashboard)`) are dropped and
 * dynamic segments (`[id]`) become `:id`, matching the templated form used by screen specs.
 */
async function buildRouteMap(
  readDir: (p: string) => Promise<DirEntry[]>,
  appDir: string,
): Promise<Map<string, string>> {
  const files = await walkFiles(readDir, appDir)
  const map = new Map<string, string>()
  for (const file of files) {
    const base = file.slice(file.lastIndexOf('/') + 1)
    if (!PAGE_NAMES.includes(base)) continue
    const rel = file.slice(appDir.length + 1, file.length - base.length - 1)
    const segs = rel
      .split('/')
      .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s))
      .map((s) => s.replace(/^\[(?:\.\.\.)?(.+)\]$/, ':$1'))
    const route = `/${segs.join('/')}`.replace(/\/$/, '') || '/'
    if (!map.has(route)) map.set(route, file)
  }
  return map
}

/** Normalize a route for map lookup: leading slash, no trailing slash. */
function normalizeRoute(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return p.length > 1 ? p.replace(/\/$/, '') : p
}

/** Every module specifier imported or re-exported by a source file. */
function importSpecifiers(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of text.matchAll(/import\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  return out
}

/**
 * Resolve an internal module specifier to a concrete file. `@/x` maps to `<frontendDir>/x`, `./x` and
 * `../x` resolve against the importer; bare (node_modules) specifiers return null. Tries the common
 * source extensions and an `index.*` barrel. Requires a reader to confirm the file exists.
 */
async function resolveModule(
  readFile: (p: string) => Promise<string>,
  frontendDir: string,
  fromFile: string,
  spec: string,
): Promise<{ file: string; text: string } | null> {
  let baseTarget: string
  if (spec.startsWith('@/')) baseTarget = join(frontendDir, spec.slice(2))
  else if (spec.startsWith('.')) baseTarget = join(dirname(fromFile), spec)
  else return null

  const candidates = [
    ...SOURCE_EXTS.map((ext) => baseTarget + ext),
    ...SOURCE_EXTS.map((ext) => join(baseTarget, `index${ext}`)),
  ]
  for (const cand of candidates) {
    const text = await tryRead(readFile, cand)
    if (text != null) return { file: cand, text }
  }
  return null
}

/**
 * Collect the source text of a page and its internal imports up to `IMPORT_DEPTH` hops. Barrels
 * (`export * from`) are followed like imports, so a page importing `@/features/x/components` reaches
 * the component that actually calls the hooks.
 */
async function collectGraphSources(
  readFile: (p: string) => Promise<string>,
  frontendDir: string,
  pageFile: string,
  pageText: string,
): Promise<string[]> {
  const seen = new Set<string>([pageFile])
  const texts = [pageText]
  let frontier: { file: string; text: string }[] = [{ file: pageFile, text: pageText }]

  for (let depth = 0; depth < IMPORT_DEPTH; depth++) {
    const next: { file: string; text: string }[] = []
    for (const node of frontier) {
      for (const spec of importSpecifiers(node.text)) {
        const resolved = await resolveModule(readFile, frontendDir, node.file, spec)
        if (!resolved || seen.has(resolved.file)) continue
        seen.add(resolved.file)
        texts.push(resolved.text)
        next.push(resolved)
      }
    }
    frontier = next
  }
  return texts
}

/** Client symbols (HookIndex keys) that appear as identifiers anywhere in the combined source. */
function matchedEndpoints(sources: string[], hookIndex: HookIndex): EndpointRef[] {
  const combined = sources.join('\n')
  const seen = new Set<string>()
  const out: EndpointRef[] = []
  for (const [name, ref] of hookIndex) {
    if (!new RegExp(`\\b${name}\\b`).test(combined)) continue
    const key = `${ref.method} ${ref.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/**
 * Best-effort label for a form field: a `<FormLabel>` immediately preceding a `name="<field>"`
 * (react-hook-form) input. Returns undefined when nothing matches — labels are optional.
 */
function labelFor(field: string, combined: string): string | undefined {
  const nameRe = new RegExp(`name=["'\`]${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`)
  const idx = combined.search(nameRe)
  if (idx < 0) return undefined
  const before = combined.slice(Math.max(0, idx - 240), idx)
  const labels = [...before.matchAll(/<FormLabel[^>]*>([^<]{1,60})<\/FormLabel>/g)]
  const last = labels.at(-1)
  return last ? last[1].trim() : undefined
}

/** Parse a zod schema (by name) into fields, sourcing the text from whichever zod file declares it. */
function fieldsFromSchema(
  ref: { name: string; file: string },
  zodSources: { file: string; text: string }[],
): FieldConstraintSpec[] {
  const src = zodSources.find((s) => s.file === ref.file)
  if (!src) return []
  return parseZodObject(src.text, ref.name) ?? []
}

/** Build the `submits` block from the first non-GET endpoint among a screen's uses. */
function buildSubmits(
  uses: EndpointRef[],
  zodSources: { file: string; text: string }[],
  hookIndex: HookIndex,
  combined: string,
  runId: string,
): ScreenSpec['submits'] {
  const mutation = uses.find((e) => e.method !== 'GET')
  if (!mutation) return undefined
  const schema = requestSchemaNameFor(mutation, zodSources, hookIndex)
  if (!schema) return { endpoint: mutation, inputs: [] }
  const inputs: ScreenSpecInput[] = fieldsFromSchema(schema, zodSources).map((c) => {
    const generated = valueForField(c, runId)
    const label = labelFor(c.field, combined)
    return {
      field: c.field,
      ...(label != null && { label }),
      constraints: c,
      ...(generated?.value != null && { value: generated.value }),
      ...(generated?.fkHint != null && { fkHint: generated.fkHint }),
    }
  })
  return { endpoint: mutation, inputs }
}

/** Build the `displays` list from the primary (first) GET endpoint's response schema fields. */
function buildDisplays(
  uses: EndpointRef[],
  zodSources: { file: string; text: string }[],
  hookIndex: HookIndex,
  combined: string,
): ScreenSpec['displays'] {
  const primaryGet = uses.find((e) => e.method === 'GET')
  if (!primaryGet) return []
  const schema = responseSchemaNameFor(primaryGet, zodSources, hookIndex)
  if (!schema) return []
  return fieldsFromSchema(schema, zodSources).map((c) => {
    const label = labelFor(c.field, combined)
    return { field: c.field, ...(label != null && { label }) }
  })
}

/** Read all `.zod.ts` sources under the zod dir into memory for schema lookups. */
async function loadZodSources(
  readFile: (p: string) => Promise<string>,
  readDir: (p: string) => Promise<DirEntry[]>,
  zodDir: string,
): Promise<{ file: string; text: string }[]> {
  const files = (await walkFiles(readDir, zodDir)).filter((f) => f.endsWith('.zod.ts'))
  const out: { file: string; text: string }[] = []
  for (const file of files) {
    const text = await tryRead(readFile, file)
    if (text != null) out.push({ file, text })
  }
  return out
}

/** Read all client `.ts` sources (skipping `.zod.ts` / `.msw.ts`) under the api dir. */
async function loadClientSources(
  readFile: (p: string) => Promise<string>,
  readDir: (p: string) => Promise<DirEntry[]>,
  apiDir: string,
): Promise<{ file: string; text: string }[]> {
  const files = (await walkFiles(readDir, apiDir)).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.zod.ts') && !f.endsWith('.msw.ts') && !f.endsWith('.d.ts'),
  )
  const out: { file: string; text: string }[] = []
  for (const file of files) {
    const text = await tryRead(readFile, file)
    if (text != null) out.push({ file, text })
  }
  return out
}

/**
 * Analyze every screen into a ScreenSpec. Endpoints are learned once (from the orval client + zod
 * output under `apiDir`/`zodDir`, both defaulting to `<frontendDir>/api`), then applied per screen.
 * Screens whose page or endpoints can't be found still produce a spec with empty `uses` (useful for
 * coverage). `opts.now` stamps `analyzedAt`; `opts.runId` seeds deterministic values.
 */
export async function analyzeScreens(
  frontendDir: string,
  screens: { path: string }[],
  opts: { apiDir?: string; zodDir?: string; runId: string; now: string },
  deps: AnalyzeDeps = {},
): Promise<ScreenSpec[]> {
  const readFile = deps.readFile ?? defaultReadFile
  const readDir = deps.readDir ?? defaultReadDir
  const apiDir = opts.apiDir ?? join(frontendDir, 'api')
  const zodDir = opts.zodDir ?? apiDir
  const appDir = join(frontendDir, 'app')

  const clientSources = await loadClientSources(readFile, readDir, apiDir)
  const hookIndex = parseOrvalClients(clientSources)
  const zodSources = await loadZodSources(readFile, readDir, zodDir)
  const routeMap = await buildRouteMap(readDir, appDir)

  const specs: ScreenSpec[] = []
  for (const screen of screens) {
    try {
      const route = normalizeRoute(screen.path)
      const pageFile = routeMap.get(route)
      let uses: EndpointRef[] = []
      let combined = ''
      if (pageFile) {
        const pageText = await tryRead(readFile, pageFile)
        if (pageText != null) {
          const sources = await collectGraphSources(readFile, frontendDir, pageFile, pageText)
          combined = sources.join('\n')
          uses = matchedEndpoints(sources, hookIndex)
        }
      } else {
        logger.warn({ screen: screen.path }, 'screen-analyze: no page file for route')
      }
      const submits = buildSubmits(uses, zodSources, hookIndex, combined, opts.runId)
      const displays = buildDisplays(uses, zodSources, hookIndex, combined)
      specs.push({
        screen: screen.path,
        analyzedAt: opts.now,
        uses,
        ...(submits != null && { submits }),
        displays,
      })
    } catch (error) {
      logger.warn({ screen: screen.path, err: String(error) }, 'screen-analyze: failed, skipping screen')
    }
  }
  return specs
}
