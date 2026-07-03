// packages/structure/src/analyze/events.ts
//
// Deterministic, pattern-based extraction of the intent↔structure diff axis from
// source code: domain EVENTS and STATE TRANSITIONS. No LLM — these two axes are
// regular enough to read statically (the reason we diff them and not fine-grained
// behaviour). Heuristics are conservative and attribution is best-effort; an
// unknown aggregate/from-state is left null rather than guessed.
//
// Events are recognised as:
//   - a `class|interface|type|enum <Name>` whose Name is PascalCase past-tense
//     (ends in "ed") or ends in "Event";
//   - a `new <Name>(` / `emit|publish|dispatch|raise|fire|record(<Name>` call with
//     such a Name.
// State transitions are recognised as a literal assigned to a `status`/`state`
// field: `x.status = "shipped"` or `status: "placed"`. `from` is null (static
// analysis sees the target, not the predecessor); aggregate/trigger come from the
// nearest enclosing `class`/`function` on the way down the file.

import type { StructureEvent, StructureStateTransition } from "../model.js";

export interface SourceFile {
  path: string;
  content: string;
}

const COMPOUND = /[a-z0-9][A-Z]/; // at least one internal hump → "OrderPlaced", not "Unified"
const EVENT_SUFFIX = /(?:ed|Event)$/;
const DECL = /\b(?:class|interface|type|enum)\s+([A-Z][A-Za-z0-9]*)/g;
const CONSTRUCTED =
  /(?:new\s+|(?:emit|publish|dispatch|raise|fire|record)\w*\(\s*["'`]?)([A-Z][A-Za-z0-9]*)/g;
const STATE_ASSIGN = /\.(?:status|state)\s*=\s*["'`]([\w][\w.-]*)["'`]/g;
const STATE_LITERAL = /\b(?:status|state)\s*:\s*["'`]([\w][\w.-]*)["'`]/g;
const CLASS_DECL = /\b(?:class|interface)\s+([A-Z][A-Za-z0-9]*)/;
const FN_DECL =
  /\b(?:function\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s+)?\(|\([^)]*\)\s*[:{]))/;

function isEventName(name: string): boolean {
  return COMPOUND.test(name) && EVENT_SUFFIX.test(name);
}

/** Extract domain events across files; dedup by name, keep the first sighting. */
export function extractEvents(files: SourceFile[]): StructureEvent[] {
  const byName = new Map<string, StructureEvent>();

  for (const file of files) {
    const lines = file.content.split("\n");
    let enclosingClass: string | undefined;

    lines.forEach((line, i) => {
      const cls = CLASS_DECL.exec(line);
      if (cls) enclosingClass = cls[1];

      const record = (name: string) => {
        if (!isEventName(name) || byName.has(name)) return;
        byName.set(name, {
          name,
          ...(enclosingClass && enclosingClass !== name ? { aggregate: enclosingClass } : {}),
          source: `${file.path}:${i + 1}`,
        });
      };

      for (const m of line.matchAll(DECL)) record(m[1]!);
      for (const m of line.matchAll(CONSTRUCTED)) record(m[1]!);
    });
  }

  return [...byName.values()];
}

/** Extract state transitions (status/state literal assignments) across files. */
export function extractStateTransitions(files: SourceFile[]): StructureStateTransition[] {
  const seen = new Set<string>();
  const out: StructureStateTransition[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");
    let enclosingClass: string | undefined;
    let enclosingFn: string | undefined;

    lines.forEach((line, i) => {
      const cls = CLASS_DECL.exec(line);
      if (cls) enclosingClass = cls[1];
      const fn = FN_DECL.exec(line);
      if (fn) enclosingFn = fn[1] ?? fn[2];

      const record = (to: string) => {
        const key = `${enclosingClass ?? ""}|${to}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          ...(enclosingClass ? { aggregate: enclosingClass } : {}),
          from: null,
          to,
          ...(enclosingFn ? { trigger: enclosingFn } : {}),
          source: `${file.path}:${i + 1}`,
        });
      };

      for (const m of line.matchAll(STATE_ASSIGN)) record(m[1]!);
      for (const m of line.matchAll(STATE_LITERAL)) record(m[1]!);
    });
  }

  return out;
}
