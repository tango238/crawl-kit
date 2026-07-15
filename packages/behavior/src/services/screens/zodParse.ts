// Extract field-level constraints from orval's zod-mode output (`.zod.ts`). For each operation orval
// emits `export const <PascalOperation><Suffix> = zod.object({...})` where suffix is `Body` (request),
// `Response`, `Params` / `QueryParams` (path & query). We tokenize the *top-level* fields of one such
// object and read the modifier chain on each (`.min` / `.max` / `.email` / `.regex` / `.enum` /
// `.optional` / `.nullable` / `.nullish`). Nested object/array shapes are recorded as a single field
// of type object/array — v1 does not recurse — so the deterministic value layer knows to skip them.

import type { EndpointRef, HookIndex } from './orval.js'

/** One request/response field with the constraints needed to synthesize a deterministic value. */
export type FieldConstraintSpec = {
  field: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'array' | 'object' | 'unknown'
  required: boolean
  min?: number
  max?: number
  email?: boolean
  regex?: string
  enumValues?: string[]
  nullable?: boolean
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Numeric `export const <name> = <number>` declarations in a zod file (orval hoists length/value
 * bounds into named consts, e.g. `.max(couponCodesIndexQueryKeywordMax)`). Resolving them lets us
 * record the real number instead of losing the bound.
 */
function numericConsts(source: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of source.matchAll(/export const ([A-Za-z0-9_$]+)\s*=\s*(-?\d+(?:\.\d+)?)\b/g)) {
    out.set(m[1], Number(m[2]))
  }
  return out
}

/**
 * Capture the balanced `{...}` body of the first `zod.object(` inside the named export. Returns the
 * inner text (without the outer braces) or null when the schema is absent or not a plain object.
 */
function objectBodyOf(source: string, schemaName: string): string | null {
  const decl = new RegExp(`export const ${escapeRegExp(schemaName)}\\b`).exec(source)
  if (!decl) return null
  const objIdx = source.indexOf('zod.object(', decl.index)
  if (objIdx === -1) return null
  const braceStart = source.indexOf('{', objIdx)
  if (braceStart === -1) return null

  let depth = 0
  let inString: string | null = null
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(braceStart + 1, i)
    }
  }
  return null
}

/** Split an object body into top-level `key: expr` entries, ignoring commas inside nested groups/strings. */
function splitTopLevelFields(body: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  let depth = 0
  let inString: string | null = null
  let start = 0
  const push = (end: number) => {
    const piece = body.slice(start, end).trim()
    start = end + 1
    if (!piece) return
    const colon = piece.indexOf(':')
    if (colon === -1) return
    const key = piece.slice(0, colon).trim().replace(/['"]/g, '')
    const value = piece.slice(colon + 1).trim()
    if (key) out.push({ key, value })
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch
    else if (ch === '{' || ch === '(' || ch === '[') depth++
    else if (ch === '}' || ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) push(i)
  }
  push(body.length)
  return out
}

/** The trailing chain of simple `.modifier(...)` calls (no nested parens), e.g. `.max(5).optional()`. */
function trailingChain(value: string): string {
  const m = value.match(/((?:\.[a-zA-Z]+\([^()]*\))+)\s*$/)
  return m ? m[1] : ''
}

/** Resolve a `.min`/`.max` argument that is either a numeric literal or a hoisted numeric const. */
function resolveNumeric(arg: string | undefined, consts: Map<string, number>): number | undefined {
  if (arg == null) return undefined
  const t = arg.trim()
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return consts.get(t)
}

/** Classify one field's value expression into a FieldConstraintSpec. */
function fieldFromValue(key: string, value: string, consts: Map<string, number>): FieldConstraintSpec {
  const tail = trailingChain(value)
  const required = !/\.(optional|nullish)\(\)/.test(tail)
  const nullable = /\.(nullable|nullish)\(\)/.test(tail)
  const base: FieldConstraintSpec = { field: key, type: 'unknown', required }
  if (nullable) base.nullable = true

  if (value.startsWith('zod.enum(')) {
    const inner = value.match(/zod\.enum\(\[([^\]]*)\]/)
    const enumValues = inner
      ? [...inner[1].matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1])
      : []
    return { ...base, type: 'enum', enumValues }
  }
  if (value.startsWith('zod.array(')) return { ...base, type: 'array' }
  if (value.startsWith('zod.object(')) return { ...base, type: 'object' }
  if (value.startsWith('zod.boolean(')) return { ...base, type: 'boolean' }
  if (value.startsWith('zod.number(')) {
    const min = resolveNumeric(value.match(/\.min\(([^)]+)\)/)?.[1], consts)
    const max = resolveNumeric(value.match(/\.max\(([^)]+)\)/)?.[1], consts)
    return { ...base, type: 'number', ...(min != null && { min }), ...(max != null && { max }) }
  }
  if (value.startsWith('zod.string(')) {
    // A string carrying `.datetime()` is a date; otherwise it's a plain string (`.min`/`.max` are lengths).
    const isDate = /\.datetime\(/.test(value)
    const min = resolveNumeric(value.match(/\.min\(([^)]+)\)/)?.[1], consts)
    const max = resolveNumeric(value.match(/\.max\(([^)]+)\)/)?.[1], consts)
    const email = /\.email\(/.test(value)
    const regex = value.match(/\.regex\(\s*\/((?:\\.|[^/])*)\//)?.[1]
    return {
      ...base,
      type: isDate ? 'date' : 'string',
      ...(min != null && { min }),
      ...(max != null && { max }),
      ...(email && { email: true }),
      ...(regex != null && { regex }),
    }
  }
  return base
}

/**
 * Parse the named zod object schema into its top-level fields. Returns null when the schema is not
 * present in the source or is not a `zod.object`. Nested objects/arrays yield a single field of the
 * corresponding container type (no deep recursion in v1).
 */
export function parseZodObject(source: string, schemaName: string): FieldConstraintSpec[] | null {
  const body = objectBodyOf(source, schemaName)
  if (body == null) return null
  const consts = numericConsts(source)
  return splitTopLevelFields(body).map(({ key, value }) => fieldFromValue(key, value, consts))
}

/** Find which source declares `export const <exportName>`, returning its name and file. */
function findExportFile(
  zodSources: { file: string; text: string }[],
  exportName: string,
): { name: string; file: string } | null {
  const re = new RegExp(`export const ${escapeRegExp(exportName)}\\b`)
  for (const src of zodSources) {
    if (re.test(src.text)) return { name: exportName, file: src.file }
  }
  return null
}

/**
 * Candidate operation base names for an endpoint: the plain client symbols mapping to it (a hook's
 * `use`/`get` wrappers are skipped — only the plain operation's PascalCase matches a zod schema name).
 */
function pascalBasesForEndpoint(endpoint: EndpointRef, hookIndex: HookIndex): string[] {
  const bases: string[] = []
  for (const [name, ref] of hookIndex) {
    if (ref.method !== endpoint.method || ref.path !== endpoint.path) continue
    if (name.startsWith('use') || name.startsWith('get')) continue
    bases.push(name[0].toUpperCase() + name.slice(1))
  }
  return bases
}

/**
 * Locate the request-body zod schema for an endpoint. Orval names it `<PascalOperation>Body`; the
 * operation name is only recoverable from the client index (an endpoint's method+path alone can't
 * reconstruct orval's operationId), so the HookIndex is required to bridge the two.
 */
export function requestSchemaNameFor(
  endpoint: EndpointRef,
  zodSources: { file: string; text: string }[],
  hookIndex: HookIndex,
): { name: string; file: string } | null {
  for (const base of pascalBasesForEndpoint(endpoint, hookIndex)) {
    const hit = findExportFile(zodSources, `${base}Body`)
    if (hit) return hit
  }
  return null
}

/**
 * Locate the response zod schema for an endpoint (`<PascalOperation>Response`). See
 * requestSchemaNameFor for why the HookIndex is required.
 */
export function responseSchemaNameFor(
  endpoint: EndpointRef,
  zodSources: { file: string; text: string }[],
  hookIndex: HookIndex,
): { name: string; file: string } | null {
  for (const base of pascalBasesForEndpoint(endpoint, hookIndex)) {
    const hit = findExportFile(zodSources, `${base}Response`)
    if (hit) return hit
  }
  return null
}
