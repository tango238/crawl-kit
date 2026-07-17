// Synthesize a deterministic dummy value for one input field from its constraints. "Deterministic"
// is the whole point: given the same field + runId the value never varies, so a spec written now and
// an explore run later agree without any randomness or clock reads. `runId` is woven into unique-ish
// fields (email / code / slug / free-text) so repeated runs don't collide on unique DB columns.

import type { FieldConstraintSpec } from './zodParse.js'

/** A generated value plus, for foreign keys, a hint naming the referenced entity for DB resolution. */
export type GeneratedValue = { value: string; fkHint?: string }

// Fixed date constant — NOT Date.now(): a moving clock would make specs non-reproducible and defeat
// diffing a re-analysis against a stored spec. A concrete calendar date any backend will accept.
const FIXED_DATE = '2026-01-15'
const PHONE = '05012345678'

/** Truncate to a max length when one is given (string length / phone digits); otherwise unchanged. */
function clamp(value: string, max?: number): string {
  return max != null && value.length > max ? value.slice(0, max) : value
}

/** Strip an `_id` / `Id` suffix and lower-case the head, e.g. `hotelId` / `hotel_id` → `hotel`. */
function fkEntity(field: string): string | null {
  const m = /^(.+?)(?:_id|Id)$/.exec(field)
  if (!m) return null
  const base = m[1].replace(/_+$/, '')
  return base ? base[0].toLowerCase() + base.slice(1) : null
}

/**
 * Deterministic value for a field, or null when nothing sensible can be produced (object / array /
 * unknown container types — the caller leaves those unfilled). Rule order, first match wins:
 *  1. foreign keys (`*_id` / `*Id`, any scalar type) → '1' plus an fkHint the runtime resolves;
 *  2. enum → first allowed value; boolean → 'true'; number → min (clamped to max) else 1;
 *  3. email → `ck-<runId>@example.com`; phone/tel field → a fixed phone number;
 *  4. date type or date-ish name (`*_at` / `*_on` / `*date*`) → the fixed date;
 *  5. otherwise a free-text `ck-<runId> <field>` (runId embedded so unique columns don't collide),
 *     truncated to any max length.
 */
export function valueForField(c: FieldConstraintSpec, runId: string): GeneratedValue | null {
  if (c.type === 'object' || c.type === 'array' || c.type === 'unknown') return null

  const field = c.field
  const fk = fkEntity(field)
  if (fk) return { value: '1', fkHint: fk }

  if (c.type === 'enum') {
    const first = c.enumValues?.[0]
    return { value: first ?? clamp(`ck-${runId} ${field}`, c.max) }
  }
  if (c.type === 'boolean') return { value: 'true' }
  if (c.type === 'number') {
    let n = c.min ?? 1
    if (c.max != null && n > c.max) n = c.max
    return { value: String(n) }
  }

  const lower = field.toLowerCase()
  if (c.email || /email/.test(lower)) return { value: `ck-${runId}@example.com` }
  if (/phone|tel/.test(lower)) return { value: clamp(PHONE, c.max) }
  // Date-ish by type or name — both snake_case (`_at`/`_on`/`date`) and camelCase (`createdAt`).
  if (c.type === 'date' || /(_at|_on|date)/.test(lower) || /[a-z](At|On)$/.test(field)) {
    return { value: FIXED_DATE }
  }

  return { value: clamp(`ck-${runId} ${field}`, c.max) }
}
