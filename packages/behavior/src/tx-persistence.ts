// packages/behavior/src/tx-persistence.ts
//
// Pure: was an HTTP mutation actually persisted, per the CRUD oracle (see
// services/crud/execute.ts)? GET/HEAD/OPTIONS never raise the question — they don't write.
// A mutation whose normalized route matches a CRUD-probed step carries that step's oracle
// verdict, but ONLY when that step actually probed the DB (`dbProbed`) — a status-only step
// (no DB adapter available) cannot honestly claim "yes"/"no", so it too degrades to
// "unknown". A mutation with no matching probe at all is also "unknown": it happened, but
// nothing confirmed whether it stuck.

import { normalizeRoute } from '@crawl-kit/reconciler'
import type { CrudEntityResult } from './services/crud/types.js'

export type PersistVerdict = 'yes' | 'no' | 'unknown'

/** The slice of a run's CRUD results annotatePersistence needs: each entity's probed steps,
 *  each carrying the normalized "METHOD /path" route it was executed against. */
export type CrudResultsLike = CrudEntityResult[]

const NON_MUTATING = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Annotate one HTTP transaction with its persistence verdict, per this run's CRUD results.
 * Path matching normalizes both sides with the shared route convention (contract's
 * normalizeRoute — :id-shaped segments collapse to `:id`), the same one execute.ts uses to
 * key its results. A matched step only yields "yes"/"no" when it was DB-probed
 * (`step.dbProbed`); a matched-but-unprobed step is "unknown", same as no match at all.
 */
export function annotatePersistence(
  tx: { method: string; path: string },
  crudResults: CrudResultsLike,
): PersistVerdict | undefined {
  const method = tx.method.toUpperCase()
  if (NON_MUTATING.has(method)) return undefined

  const key = normalizeRoute(`${method} ${tx.path}`)
  for (const entityResult of crudResults) {
    const step = entityResult.steps.find((s) => s.route === key)
    if (step) {
      if (!step.dbProbed) return 'unknown'
      return step.ok ? 'yes' : 'no'
    }
  }
  return 'unknown'
}
