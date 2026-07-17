// Index the API endpoints an orval-generated client references, keyed by the exported symbol a
// screen's code would import (the plain operation function AND its SWR hook / mutation-fetcher
// wrappers). Screen analysis scans component source for these symbol names to learn which
// endpoints a screen calls — no runtime, no OpenAPI parse.
//
// orval (tags-split, swr client) emits, per operation, a plain function whose body holds the one
// axiosInstance call carrying a `url:` template and a `method:` literal, plus wrappers
// (`useXxx`, `getXxxMutationFetcher`) that delegate to it by name. We read the literal endpoint off
// the plain function, then propagate it to every wrapper that (transitively) calls a known symbol.

import { join } from 'node:path'
import { readdir, readFile as fsReadFile } from 'node:fs/promises'

/** One endpoint as written in the generated client. `path` keeps orval's template form (`{hotelId}`). */
export type EndpointRef = { method: string /* UPPER */; path: string /* e.g. /hotels/{hotelId} */ }
/** Exported client symbol (function or hook) → the endpoint it (transitively) calls. */
export type HookIndex = Map<string, EndpointRef>

/** One exported declaration lifted from a source file: its name and full body text. */
type Decl = { name: string; body: string }

const EXPORT_DECL = /export\s+(?:const|async\s+function|function)\s+([A-Za-z_$][\w$]*)/g

/** `${hotelId}` → `{hotelId}` so a client template lines up with an OpenAPI-style route. */
function normalizeTemplatePath(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_m, g: string) => `{${g.trim()}}`).trim()
}

/**
 * Slice a file into exported declarations. Each declaration's body runs from its `export` keyword
 * up to the next top-level `export` (or EOF) — coarse but sufficient, since generated code puts one
 * operation (and its wrappers) per export with no manual nesting between them.
 */
function splitDecls(text: string): Decl[] {
  const starts: { name: string; index: number }[] = []
  for (const m of text.matchAll(EXPORT_DECL)) {
    starts.push({ name: m[1], index: m.index ?? 0 })
  }
  return starts.map((s, i) => ({
    name: s.name,
    body: text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length),
  }))
}

/** Pull the first `url: <template|string>` literal out of a declaration body, normalized. */
function urlOf(body: string): string | null {
  const m = body.match(/url:\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/)
  if (!m) return null
  return normalizeTemplatePath(m[1] ?? m[2] ?? m[3] ?? '')
}

/** Pull the first `method: '<verb>'` literal out of a declaration body, upper-cased. */
function methodOf(body: string): string | null {
  const m = body.match(/method:\s*['"]([A-Za-z]+)['"]/)
  return m ? m[1].toUpperCase() : null
}

/**
 * Build the symbol → endpoint index from already-read client sources. Two passes:
 *  1. direct — declarations carrying both a `url:` and `method:` literal (the plain operations).
 *  2. delegation to a fixpoint — any remaining declaration that calls a symbol already in the index
 *     inherits that endpoint (covers `useXxx` hooks and `getXxxMutationFetcher`, including the hook →
 *     fetcher → operation two-hop). Never throws: unparseable files contribute nothing.
 */
export function parseOrvalClients(sources: { file: string; text: string }[]): HookIndex {
  const index: HookIndex = new Map()
  const pending: Decl[] = []

  for (const src of sources) {
    let decls: Decl[]
    try {
      decls = splitDecls(src.text)
    } catch {
      continue
    }
    for (const decl of decls) {
      const url = urlOf(decl.body)
      const method = methodOf(decl.body)
      if (url && method) index.set(decl.name, { method, path: url })
      else pending.push(decl)
    }
  }

  // Propagate endpoints to delegating wrappers until no further symbol can be resolved.
  let changed = true
  while (changed) {
    changed = false
    for (const decl of pending) {
      if (index.has(decl.name)) continue
      for (const [known, ref] of index) {
        if (known === decl.name) continue
        if (new RegExp(`\\b${known}\\s*\\(`).test(decl.body)) {
          index.set(decl.name, ref)
          changed = true
          break
        }
      }
    }
  }

  return index
}

/** Recursively collect `.ts` client files under a dir, skipping orval's `.zod.ts` / `.msw.ts` outputs. */
async function collectClientFiles(apiDir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(apiDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(apiDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectClientFiles(full)))
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.zod.ts') &&
      !entry.name.endsWith('.msw.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full)
    }
  }
  return out
}

/** Read every client `.ts` under `apiDir` and parse it into a HookIndex. Files that error are skipped. */
export async function buildHookIndex(apiDir: string): Promise<HookIndex> {
  const files = await collectClientFiles(apiDir)
  const sources: { file: string; text: string }[] = []
  for (const file of files) {
    try {
      sources.push({ file, text: await fsReadFile(file, 'utf8') })
    } catch {
      // Unreadable file — skip, never fail the whole index.
    }
  }
  return parseOrvalClients(sources)
}
