// packages/cli/src/commands/aggregate-mapping-io.ts
//
// Emits the DDD aggregate → structure-entity mapping right after reconcile
// writes unified.json. Best-effort and silent: intent aggregates are an
// optional artifact (P3), so a missing/unreadable data/unified.json or
// data/intent.aggregates.json just means "nothing to derive yet" — reconcile
// itself must keep working with no intent phase at all. Pure module — no
// console output here; the caller (cmdReconcile) decides what to print.

import {
  DATA_FILES,
  dataPath,
  readJsonFileOr,
  readUnified,
  writeJsonAtomic,
} from "@crawl-kit/contract";
import { deriveAggregateEntityMapping, type AggregateDocLike } from "@crawl-kit/reconciler";

export interface WriteAggregateMappingResult {
  written: boolean;
  aggregates: number;
  unassigned: number;
}

const SKIPPED: WriteAggregateMappingResult = { written: false, aggregates: 0, unassigned: 0 };

/**
 * Derive + write data/mapping.aggregate-entity.json from data/unified.json and
 * data/intent.aggregates.json. Only runs when BOTH files exist and parse —
 * either missing/unreadable is a silent no-op (returns `written: false`).
 */
export async function writeAggregateMapping(): Promise<WriteAggregateMappingResult> {
  let unified;
  try {
    unified = await readUnified(dataPath(DATA_FILES.unified));
  } catch {
    return SKIPPED;
  }

  const aggregates = await readJsonFileOr<AggregateDocLike | null>(
    dataPath(DATA_FILES.intentAggregates),
    null,
  );
  if (!aggregates) return SKIPPED;

  const mapping = deriveAggregateEntityMapping(unified, aggregates);
  await writeJsonAtomic(dataPath(DATA_FILES.aggregateEntityMapping), mapping);

  return {
    written: true,
    aggregates: mapping.aggregates.length,
    unassigned: mapping.unassigned.length,
  };
}
