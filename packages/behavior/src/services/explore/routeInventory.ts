// Pre-enumerate the API routes an app is expected to expose — the coverage denominator the
// explore run measures recorded traffic against. Sources, in priority order: an explicit file, an
// explicit command's stdout, or (fallback) the crawl-kit structure spine already on disk. The
// parser auto-detects the common shapes (OpenAPI, Laravel route:list, a JSON string array, or
// plain "METHOD /path" lines) so a project can point at whatever it already has.

import { join, isAbsolute } from 'node:path'
import { readFile as fsReadFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeRoute } from '@crawl-kit/reconciler'

/** One expected route from the pre-enumerated inventory (coverage denominator). */
export type InventoryRoute = { key: string /* normalizeRoute'd */; method: string; path: string /* raw templated */ }
export type RouteInventory = { source: 'file' | 'command' | 'structure'; routes: InventoryRoute[] }
export type RouteInventoryConfig = { file?: string; command?: string; include?: string[]; exclude?: string[] }
export type RouteInventoryDeps = { readFile?: (p: string) => Promise<string>; exec?: (command: string, cwd: string) => Promise<string> }

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const OPENAPI_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/** Ensure a leading slash without doubling one, leaving the rest of the path untouched. */
function withLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

/** Split a "METHOD /path" token into its parts; a token with no space defaults to GET. */
function splitMethodPath(token: string): { method: string; path: string } {
  const trimmed = token.trim()
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { method: 'GET', path: withLeadingSlash(trimmed) }
  return { method: trimmed.slice(0, idx).toUpperCase(), path: withLeadingSlash(trimmed.slice(idx + 1).trim()) }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** OpenAPI `paths` object → one entry per (path, HTTP method) present. */
function parseOpenApi(paths: Record<string, unknown>): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = []
  for (const [path, ops] of Object.entries(paths)) {
    if (!isRecord(ops)) continue
    for (const m of OPENAPI_METHODS) {
      if (m in ops) out.push({ method: m.toUpperCase(), path })
    }
  }
  return out
}

/** Laravel `route:list --json`: objects with `method` ("GET|HEAD") and `uri` (no leading slash). */
function parseLaravel(rows: Record<string, unknown>[]): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = []
  for (const row of rows) {
    const uri = String(row.uri ?? '')
    const methods = String(row.method ?? '')
      .split('|')
      .map((m) => m.trim().toUpperCase())
      .filter((m) => m && m !== 'HEAD' && m !== 'OPTIONS')
    for (const method of methods) out.push({ method, path: withLeadingSlash(uri) })
  }
  return out
}

/**
 * Parse a routes source into raw {method, path} pairs, auto-detecting (in order): OpenAPI JSON,
 * Laravel route:list JSON, a JSON string array of "METHOD /path", or plain text lines. Throws
 * a descriptive Error when the text is valid JSON but matches no known shape.
 */
export function parseRoutesText(text: string): { method: string; path: string }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON — plain "METHOD /path" lines, skipping blanks and #-comments.
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .map(splitMethodPath)
  }

  if (isRecord(parsed) && isRecord(parsed.paths)) return parseOpenApi(parsed.paths)
  if (Array.isArray(parsed)) {
    if (parsed.every((e) => typeof e === 'string')) return (parsed as string[]).map(splitMethodPath)
    if (parsed.every((e) => isRecord(e) && 'method' in e && 'uri' in e)) {
      return parseLaravel(parsed as Record<string, unknown>[])
    }
  }
  throw new Error('parseRoutesText: valid JSON but no recognized routes shape (expected OpenAPI paths, Laravel route:list, or a string array)')
}

/**
 * Keep routes whose path falls under an include prefix (all, when include is empty/undefined) and
 * drop any under an exclude prefix — exclude wins. Prefixes and paths are compared as leading-slash
 * strings via plain startsWith (documented, deliberately simple — no segment-boundary check).
 */
export function filterRoutes(
  routes: { method: string; path: string }[],
  include?: string[],
  exclude?: string[],
): { method: string; path: string }[] {
  const inc = (include ?? []).map(withLeadingSlash)
  const exc = (exclude ?? []).map(withLeadingSlash)
  return routes.filter((r) => {
    const p = withLeadingSlash(r.path)
    if (exc.some((e) => p.startsWith(e))) return false
    if (inc.length === 0) return true
    return inc.some((i) => p.startsWith(i))
  })
}

/** Default file reader — utf8 from the local filesystem. */
const defaultReadFile = (p: string): Promise<string> => fsReadFile(p, 'utf8')

/** Default command runner — shell out via /bin/sh -c, returning stdout (10MB buffer). */
const execFileAsync = promisify(execFile)
const defaultExec = async (command: string, cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync('/bin/sh', ['-c', command], { cwd, maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

/** structure.nodes.json → {method, path} for every `structure:route/` node (key from `.route`). */
function routesFromStructureNodes(text: string): { method: string; path: string }[] {
  const nodes = JSON.parse(text) as { nodeId?: string; route?: string }[]
  if (!Array.isArray(nodes)) return []
  return nodes
    .filter((n) => typeof n.nodeId === 'string' && n.nodeId.startsWith('structure:route/') && typeof n.route === 'string')
    .map((n) => splitMethodPath(n.route as string))
}

/** structure.routes.partial.json → its {method, path} entries verbatim (Pass-1 fallback). */
function routesFromStructurePartial(text: string): { method: string; path: string }[] {
  const rows = JSON.parse(text) as { method?: string; path?: string }[]
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => typeof r.path === 'string')
    .map((r) => ({ method: String(r.method ?? 'GET').toUpperCase(), path: withLeadingSlash(String(r.path)) }))
}

/** Best-effort read; a missing/unreadable fallback file yields null (never throws). */
async function tryRead(readFile: (p: string) => Promise<string>, path: string): Promise<string | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

/** Finalize raw routes: filter, normalize to a key, dedupe (first wins), sort by path then method. */
function finalize(source: RouteInventory['source'], raw: { method: string; path: string }[], cfg: RouteInventoryConfig | undefined): RouteInventory {
  const filtered = filterRoutes(raw, cfg?.include, cfg?.exclude)
  const byKey = new Map<string, InventoryRoute>()
  for (const r of filtered) {
    const key = normalizeRoute(`${r.method} ${r.path}`)
    if (!byKey.has(key)) byKey.set(key, { key, method: r.method.toUpperCase(), path: r.path })
  }
  const routes = [...byKey.values()].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
  return { source, routes }
}

/**
 * Load the expected-route inventory. Resolution order: cfg.file → cfg.command → structure spine
 * fallback (structure.nodes.json, then structure.routes.partial.json under `<root>/data`). Parse
 * errors from an explicitly configured file/command propagate; missing fallback files return null.
 */
export async function loadRouteInventory(
  root: string,
  cfg: RouteInventoryConfig | undefined,
  deps: RouteInventoryDeps = {},
): Promise<RouteInventory | null> {
  const readFile = deps.readFile ?? defaultReadFile
  const exec = deps.exec ?? defaultExec

  if (cfg?.file) {
    const resolved = isAbsolute(cfg.file) ? cfg.file : join(root, cfg.file)
    const text = await readFile(resolved)
    return finalize('file', parseRoutesText(text), cfg)
  }

  if (cfg?.command) {
    const stdout = await exec(cfg.command, root)
    return finalize('command', parseRoutesText(stdout), cfg)
  }

  const nodesText = await tryRead(readFile, join(root, 'data', 'structure.nodes.json'))
  if (nodesText) {
    const raw = routesFromStructureNodes(nodesText)
    if (raw.length > 0) return finalize('structure', raw, cfg)
  }
  const partialText = await tryRead(readFile, join(root, 'data', 'structure.routes.partial.json'))
  if (partialText) {
    const raw = routesFromStructurePartial(partialText)
    if (raw.length > 0) return finalize('structure', raw, cfg)
  }
  return null
}
