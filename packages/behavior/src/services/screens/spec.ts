// The ScreenSpec model and its on-disk form. A ScreenSpec is the static, pre-computed contract for
// one frontend screen: the endpoints its code calls, the first mutation it submits (with request
// fields already resolved to deterministic values), and the fields it displays from the primary GET.
// The explorer consumes these at browser time so no LLM has to reason about a screen live.

import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { ensureDir, readYaml, writeYaml } from '../../util/fs.js'
import type { EndpointRef } from './orval.js'
import type { FieldConstraintSpec } from './zodParse.js'

/** One request field of a screen's submit: its constraints plus a resolved value and FK hint. */
export type ScreenSpecInput = {
  field: string
  label?: string
  constraints: FieldConstraintSpec
  value?: string
  fkHint?: string
}

/** The static contract for one screen, keyed by its templated route (`/orders/:id`). */
export type ScreenSpec = {
  screen: string
  analyzedAt: string
  uses: EndpointRef[]
  submits?: { endpoint: EndpointRef; inputs: ScreenSpecInput[] }
  displays: { field: string; label?: string }[]
}

/** One row of the on-disk index that ties a screen to its spec file. */
type IndexEntry = { screen: string; file: string; hasSubmit: boolean }

const SPECS_DIR = 'data/screen-specs'
const INDEX_FILE = 'index.json'

/** Turn a templated route into a filesystem-safe slug: `/orders/:id` → `orders-_id`, `/` → `index`. */
export function screenSlug(screen: string): string {
  const slug = screen
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\//g, '-')
    .replace(/:/g, '_')
  return slug || 'index'
}

/** Write one YAML file per spec plus an `index.json` manifest under `<root>/data/screen-specs`. */
export async function saveScreenSpecs(root: string, specs: ScreenSpec[]): Promise<void> {
  const dir = join(root, SPECS_DIR)
  await ensureDir(dir)
  const index: IndexEntry[] = []
  for (const spec of specs) {
    const file = `${screenSlug(spec.screen)}.yaml`
    await writeYaml(join(dir, file), spec)
    index.push({ screen: spec.screen, file, hasSubmit: spec.submits != null })
  }
  await writeFile(join(dir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

/** Load specs via the manifest; a missing manifest (never analyzed) yields an empty list. */
export async function loadScreenSpecs(root: string): Promise<ScreenSpec[]> {
  const dir = join(root, SPECS_DIR)
  let index: IndexEntry[]
  try {
    index = JSON.parse(await readFile(join(dir, INDEX_FILE), 'utf8')) as IndexEntry[]
  } catch {
    return []
  }
  const specs: ScreenSpec[] = []
  for (const entry of index) {
    try {
      specs.push(await readYaml<ScreenSpec>(join(dir, entry.file)))
    } catch {
      // Manifest references a spec file that is missing/unreadable — skip it.
    }
  }
  return specs
}

/** Split a path into non-empty segments. */
function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0)
}

/** Does a templated screen (`/orders/:id`) match a concrete path segment-wise (`:param` = wildcard)? */
function screenMatches(template: string, concrete: string): boolean {
  const t = segments(template)
  const c = segments(concrete)
  if (t.length !== c.length) return false
  return t.every((seg, i) => seg.startsWith(':') || seg === c[i])
}

/**
 * Find the spec whose templated `screen` matches a concrete path. When several match, the most
 * specific wins (fewest `:param` segments), keeping the choice deterministic.
 */
export function specForScreen(specs: ScreenSpec[], concretePath: string): ScreenSpec | null {
  const matches = specs
    .filter((s) => screenMatches(s.screen, concretePath))
    .sort((a, b) => paramCount(a.screen) - paramCount(b.screen))
  return matches[0] ?? null
}

/** Count `:param` segments in a templated route (lower = more specific). */
function paramCount(screen: string): number {
  return segments(screen).filter((s) => s.startsWith(':')).length
}
