// packages/structure/src/analyze/passes.ts
//
// Task 5 of the incremental/distributed analyzer: the orchestrator. runPasses enumerates
// units, then for each pass fans the units out through the shared limiter — reusing a cached
// fragment when the unit's hash is unchanged (the diff) and parsing only the dirty ones —
// and folds the results at a per-pass sync barrier (mergeFragments), emitting after each.
// The fragment cache (keyed by unit hash) IS the diff store: an unchanged unit hits, a
// changed unit's new hash misses and re-parses. Pass 1 (route inventory) completes first,
// so downstream e2e/CRUD planning can start before passes 2/3 add detail.

import { makeLimiter, resolveClaudeCodeConcurrency, type Limiter } from "@crawl-kit/contract";
import { fragmentsCacheDir, readFragment, writeFragment, type StructureFragment } from "./fragments.js";
import type { LlmProvider } from "./llm/provider.js";
import { mergeFragments, type MergedStructure } from "./merge.js";
import { parseUnit } from "./scoped-parser.js";
import { enumerateUnits, type Unit } from "./units.js";

export interface RunPassesOpts {
  /** which passes to run, in order (default [1, 2, 3]). */
  passes?: number[];
  /** ignore the fragment cache and re-parse every unit. */
  force?: boolean;
  /** project-context preamble forwarded to the parser. */
  context?: string;
}

export interface RunPassesDeps {
  /** the resolved provider, or null for offline. */
  llm: LlmProvider | null;
  /** override unit enumeration (tests inject a fixed set). */
  enumerate?: (repoPath: string) => Unit[];
  /** override the per-unit parser (tests inject a counter/fake). */
  parse?: (unit: Unit, pass: number, deps: { llm: LlmProvider | null; repoPath: string; context?: string }) => Promise<StructureFragment>;
  /** concurrency limiter (default: shared CLAUDE_CODE_MAX_CONCURRENCY-sized limiter). */
  limiter?: Limiter;
  /** fragment cache directory (default: <repo>/.crawl-kit-cache). */
  cacheDir?: string;
  /** called after each pass with the merged structure — for progressive emit. */
  onPass?: (pass: number, merged: MergedStructure, units: Unit[]) => void | Promise<void>;
  /** called once per unit per pass when that unit's fragment is finalized (cache hit or fresh parse). index is 1-based and monotonically increasing within the pass; total is the pass's unit count. */
  onUnit?: (pass: number, unitId: string, index: number, total: number) => void | Promise<void>;
}

export interface PassResult {
  pass: number;
  merged: MergedStructure;
}

export interface RunPassesResult {
  units: Unit[];
  passes: PassResult[];
}

/** Run the analysis passes over a repo: enumerate → (per pass) fan-out+diff → merge → emit. */
export async function runPasses(
  repoPath: string,
  opts: RunPassesOpts,
  deps: RunPassesDeps,
): Promise<RunPassesResult> {
  const units = (deps.enumerate ?? enumerateUnits)(repoPath);
  const cacheDir = deps.cacheDir ?? fragmentsCacheDir(repoPath);
  const limiter = deps.limiter ?? makeLimiter(resolveClaudeCodeConcurrency());
  const parse = deps.parse ?? parseUnit;
  const passes = opts.passes ?? [1, 2, 3];

  const results: PassResult[] = [];
  for (const pass of passes) {
    let done = 0; // completion counter for this pass — incremented in the completion callback so it stays monotonic under concurrent fan-out
    const frags = await Promise.all(
      units.map((u) =>
        limiter(async () => {
          if (!opts.force) {
            const cached = readFragment(cacheDir, u.id, u.hash, pass);
            if (cached) {
              await deps.onUnit?.(pass, u.id, ++done, units.length); // diff: unchanged unit served from cache
              return cached;
            }
          }
          const frag = await parse(u, pass, { llm: deps.llm, repoPath, context: opts.context });
          writeFragment(cacheDir, frag);
          await deps.onUnit?.(pass, u.id, ++done, units.length);
          return frag;
        }),
      ),
    );
    const merged = mergeFragments(frags);
    await deps.onPass?.(pass, merged, units);
    results.push({ pass, merged });
  }

  return { units, passes: results };
}
