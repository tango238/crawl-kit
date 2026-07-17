// Bridges the static ScreenSpec (Phase 2 analysis) into the explore pipeline's existing types so
// spec-covered screens run WITHOUT any browser-time LLM: the form shape, constraints, and baseline
// values all come from the pre-computed spec; the LLM path (inferCandidateTables/modelConstraints)
// stays as the fallback for screens without a spec.

import { normalizeRoute } from '@crawl-kit/reconciler'
import type { ScreenSpec, ScreenSpecInput } from './spec.js'
import type { FieldConstraintSpec } from './zodParse.js'
import type { DiscoveredForm, FieldConstraint, Baseline } from '../explore/types.js'
import type { DbAdapter } from '../db/adapter.js'

/** Selector for a spec input: react-hook-form registers by `name`, so [name=…] is canonical. */
function selectorFor(field: string): string {
  return `[name="${field}"]`
}

function htmlTypeFor(c: FieldConstraintSpec): string {
  if (c.email) return 'email'
  if (c.type === 'number') return 'number'
  if (c.type === 'date') return 'date'
  if (c.type === 'boolean') return 'checkbox'
  return 'text'
}

/** Build the DiscoveredForm the explore executor drives, from the spec's submit inputs. */
export function specToForm(spec: ScreenSpec, screenPath: string): DiscoveredForm | null {
  if (!spec.submits || spec.submits.inputs.length === 0) return null
  return {
    screenPath,
    submitSelector: 'button[type="submit"]',
    fields: spec.submits.inputs.map((i) => ({
      name: i.field,
      selector: selectorFor(i.field),
      htmlType: htmlTypeFor(i.constraints),
      ...(i.label ? { label: i.label } : {}),
    })),
  }
}

function constraintTypeFor(c: FieldConstraintSpec): FieldConstraint['type'] {
  if (c.email) return 'email'
  switch (c.type) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'date': return 'date'
    case 'enum': return 'enum'
    default: return 'unknown'
  }
}

/** Map the spec's zod-derived constraints onto the explore FieldConstraint shape. */
export function specToConstraints(spec: ScreenSpec): FieldConstraint[] {
  if (!spec.submits) return []
  return spec.submits.inputs.map((i) => {
    const c = i.constraints
    const isString = c.type === 'string'
    return {
      field: i.field,
      selector: selectorFor(i.field),
      required: c.required,
      type: constraintTypeFor(c),
      // zod .min/.max on strings are LENGTH bounds; on numbers they are VALUE bounds.
      maxLength: isString ? c.max : undefined,
      minLength: isString ? c.min : undefined,
      min: !isString ? c.min : undefined,
      max: !isString ? c.max : undefined,
      format: c.regex,
      enumValues: c.enumValues,
      table: undefined,
      column: undefined,
      evidence: 'screen-spec (orval/zod static analysis)',
    }
  })
}

/** Baseline (selector → valid value) from the spec's pre-generated values. */
export function specBaseline(spec: ScreenSpec): Baseline {
  const out: Baseline = {}
  for (const i of spec.submits?.inputs ?? []) {
    if (i.value != null) out[selectorFor(i.field)] = i.value
  }
  return out
}

/**
 * Resolve FK placeholder values against the live DB: an input generated with `fkHint: 'hotel'`
 * gets the first existing id from `hotels` (then `hotel`) so submits reference real rows. Purely
 * best-effort — any failure keeps the placeholder value. Table names are interpolated but come
 * from our own static analysis (field names), never user input; they are also sanitized.
 */
export async function resolveFkInputs(
  inputs: ScreenSpecInput[],
  db: DbAdapter,
): Promise<ScreenSpecInput[]> {
  const resolved: ScreenSpecInput[] = []
  for (const input of inputs) {
    if (!input.fkHint || input.value == null) {
      resolved.push(input)
      continue
    }
    const hint = input.fkHint.replace(/[^a-z0-9_]/gi, '')
    let value = input.value
    for (const table of [`${hint}s`, hint]) {
      try {
        const rows = await db.query(`SELECT id FROM ${table} ORDER BY id LIMIT 1`, [])
        const id = rows[0]?.id
        if (id != null) {
          value = String(id)
          break
        }
      } catch {
        /* table missing — try the next candidate, else keep the placeholder */
      }
    }
    resolved.push({ ...input, value })
  }
  return resolved
}

/** The resource a screen's submit creates/updates: last non-templated segment of its endpoint. */
function resourceOf(spec: ScreenSpec): string | null {
  const path = spec.submits?.endpoint.path
  if (!path) return null
  const segments = path.split('/').filter((s) => s && !s.startsWith('{') && !s.startsWith(':'))
  return segments.length > 0 ? segments[segments.length - 1].toLowerCase() : null
}

/** FK hints a screen's inputs reference, normalized to plural resource names. */
function dependenciesOf(spec: ScreenSpec): string[] {
  const hints = (spec.submits?.inputs ?? []).flatMap((i) => (i.fkHint ? [i.fkHint.toLowerCase()] : []))
  return hints.map((h) => (h.endsWith('s') ? h : `${h}s`))
}

/**
 * Order explore screens so that screens which CREATE a resource run before screens whose inputs
 * REFERENCE it (booking needs a hotel to exist). Stable: screens keep their relative order except
 * when a dependency forces a provider earlier; unknown/spec-less screens keep their position.
 * Cycles degrade to the original order (no infinite loops).
 */
export function orderScreensByDependency(screens: string[], specs: ScreenSpec[]): string[] {
  const specByScreen = new Map<string, ScreenSpec>()
  for (const s of screens) {
    const spec = specs.find((x) => normalizeRoute(x.screen) === normalizeRoute(s))
    if (spec) specByScreen.set(s, spec)
  }
  const provides = new Map<string, string>() // resource -> screen that creates it
  for (const [screen, spec] of specByScreen) {
    const r = resourceOf(spec)
    if (r && !provides.has(r)) provides.set(r, screen)
  }

  const result: string[] = []
  const placed = new Set<string>()
  const placing = new Set<string>() // cycle guard
  const place = (screen: string): void => {
    if (placed.has(screen) || placing.has(screen)) return
    placing.add(screen)
    const spec = specByScreen.get(screen)
    for (const dep of spec ? dependenciesOf(spec) : []) {
      const provider = provides.get(dep)
      if (provider && provider !== screen) place(provider)
    }
    placing.delete(screen)
    placed.add(screen)
    result.push(screen)
  }
  for (const s of screens) place(s)
  return result
}
