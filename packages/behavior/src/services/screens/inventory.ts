// Static screen inventory: enumerate the screens (pages) a Next.js frontend declares in its router
// directory, WITHOUT running the app. This is the denominator for cumulative "screen coverage"
// (mirrors routeInventory.ts for API routes) and the seed list that guarantees the crawl visits
// every declared screen even when nothing links to it. App Router is preferred; Pages Router is the
// fallback. Paths are templated (route params become `:param`, e.g. `/hotel/:id`).

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One declared screen. `path` is templated with a leading slash (e.g. `/hotel/:id`, `/` for root). */
export type Screen = { path: string }
export type ScreenInventory = { source: 'nextjs-app-router' | 'nextjs-pages'; screens: Screen[] }

const PAGE_FILE = /^page\.(tsx|jsx|ts|js)$/
const PAGE_EXT = /\.(tsx|jsx|ts|js)$/
/** Pages-router special files that are not routable screens. */
const PAGES_SPECIAL = new Set(['_app', '_document', '_error'])

/** Route group `(name)` — contributes nothing to the URL. App Router only. */
function isRouteGroup(name: string): boolean {
  return name.startsWith('(') && name.endsWith(')')
}

/**
 * Map one directory/file segment to its URL segment. Dynamic segments collapse to `:param`:
 * `[id]` → `:id`, `[...slug]` and `[[...slug]]` (catch-all / optional catch-all) → `:slug`.
 * A static segment is returned unchanged.
 */
function mapDynamicSegment(name: string): string {
  const catchAll = name.match(/^\[\[?\.\.\.(.+?)\]?\]$/)
  if (catchAll) return `:${catchAll[1]}`
  const dyn = name.match(/^\[(.+?)\]$/)
  if (dyn) return `:${dyn[1]}`
  return name
}

/** Assemble URL segments into a templated path with a leading slash; `[]` → `/`. */
function segmentsToPath(segments: string[]): string {
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

/**
 * Recursively walk an App Router directory. A directory that contains a `page.*` file IS a screen;
 * route groups `(name)` are transparent to the URL; `@slot` (parallel routes) and `_private` dirs
 * are skipped entirely (they never produce a navigable URL of their own).
 */
async function walkAppDir(dir: string, segments: string[], out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })

  if (entries.some((e) => e.isFile() && PAGE_FILE.test(e.name))) {
    out.push(segmentsToPath(segments))
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    const name = e.name
    if (name.startsWith('@') || name.startsWith('_')) continue // parallel-route slot / private dir
    const next = isRouteGroup(name) ? segments : [...segments, mapDynamicSegment(name)]
    await walkAppDir(join(dir, name), next, out)
  }
}

/**
 * Recursively collect routable page files under a Pages Router directory. `api/**` is skipped
 * (not screens); `_app`/`_document`/`_error` are skipped (framework internals). Each remaining
 * `.tsx`/`.jsx` file maps to a route: its path relative to `pagesDir`, extension stripped, dynamic
 * segments templated, and a trailing `index` dropped (so `blog/index.tsx` → `/blog`).
 */
async function walkPagesDir(pagesDir: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === 'api') continue
      await walkPagesDir(pagesDir, join(dir, e.name), out)
      continue
    }
    if (!e.isFile() || !/\.(tsx|jsx)$/.test(e.name)) continue
    const base = e.name.replace(PAGE_EXT, '')
    if (PAGES_SPECIAL.has(base)) continue
    const rel = relative(pagesDir, join(dir, base)) // extension-less path relative to pages/
    const parts = rel.split(sep).filter((p) => p.length > 0).map(mapDynamicSegment)
    if (parts[parts.length - 1] === 'index') parts.pop()
    out.push(segmentsToPath(parts))
  }
}

/** Sort by path and drop duplicate paths (two files can map to the same templated route). */
function dedupeSorted(paths: string[]): Screen[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b)).map((path) => ({ path }))
}

/**
 * Enumerate the screens a Next.js frontend declares. App Router (`<frontendDir>/app`) wins; if only
 * `<frontendDir>/pages` exists, that Pages Router directory is scanned instead. Returns null when
 * neither router directory is present (not a recognizable Next.js frontend).
 */
export async function collectScreenInventory(frontendDir: string): Promise<ScreenInventory | null> {
  const appDir = join(frontendDir, 'app')
  if (existsSync(appDir)) {
    const paths: string[] = []
    await walkAppDir(appDir, [], paths)
    return { source: 'nextjs-app-router', screens: dedupeSorted(paths) }
  }

  const pagesDir = join(frontendDir, 'pages')
  if (existsSync(pagesDir)) {
    const paths: string[] = []
    await walkPagesDir(pagesDir, pagesDir, paths)
    return { source: 'nextjs-pages', screens: dedupeSorted(paths) }
  }

  return null
}

/** A URL that points at a local path (`file://` or an absolute path) rather than a remote git remote. */
function localPathFromUrl(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url)
    } catch {
      return null
    }
  }
  if (url.startsWith('/')) return url
  return null
}

/**
 * Locate the on-disk directory of the first `role: 'frontend'` repository. Candidates are tried in
 * order — the workspace clone at `<root>/<repo.path>` (when `path` is set), the default clone at
 * `<root>/<repo.name>`, and (when `repo.url` is itself a local path/`file://`) that path directly —
 * returning the first that exists on disk. Null when there is no frontend repo or none resolves.
 */
export function resolveFrontendDir(
  root: string,
  repositories: { name: string; url: string; role: string; path?: string }[],
): string | null {
  const frontend = repositories.find((r) => r.role === 'frontend')
  if (!frontend) return null

  const candidates: string[] = []
  if (frontend.path) candidates.push(join(root, frontend.path))
  candidates.push(join(root, frontend.name))
  const local = localPathFromUrl(frontend.url)
  if (local) candidates.push(local)

  return candidates.find((c) => existsSync(c)) ?? null
}
