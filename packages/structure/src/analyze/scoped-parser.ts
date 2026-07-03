// packages/structure/src/analyze/scoped-parser.ts
//
// Task 3 of the incremental/distributed analyzer: parse ONE unit at ONE pass into a
// fragment. Where SourceParser sweeps the whole repo in a single agentic run, parseUnit
// scopes the LLM to just the unit's files — small, fast, and (crucially) tolerant: a bad
// reply yields an empty fragment rather than aborting, so one unhealthy unit never sinks
// the run. Pass 1 asks only for a route inventory (cheap); pass 2 asks for detail.

import { emptyFragment, type FragmentRef, type StructureFragment } from "./fragments.js";
import type { LlmProvider } from "./llm/provider.js";
import type { ParsedController, ParsedModel, ParsedRoute } from "./source-parser.js";
import type { Unit } from "./units.js";

export interface ParseUnitDeps {
  /** the resolved provider, or null for offline (returns an empty fragment). */
  llm: LlmProvider | null;
  /** repo root — cwd for the autonomous (analyzeCodebase) backend. */
  repoPath: string;
  /** project-context preamble injected into the prompt (optional). */
  context?: string;
  /** per-pass timeout override in seconds. */
  timeoutSec?: number;
}

/** Parse a single unit at the given pass into a fragment. Never throws on LLM output. */
export async function parseUnit(unit: Unit, pass: number, deps: ParseUnitDeps): Promise<StructureFragment> {
  const base = emptyFragment(unit.id, unit.hash, pass);
  if (!deps.llm) return base;

  const prompt = buildPrompt(unit, pass, deps.context);
  let reply: string;
  try {
    reply = deps.llm.analyzeCodebase
      ? await deps.llm.analyzeCodebase(deps.repoPath, prompt, deps.timeoutSec ?? passTimeout(pass))
      : await deps.llm.completeSimple(prompt);
  } catch {
    return base; // a unit that fails to parse is skipped, not fatal
  }

  const json = extractJson(reply);
  if (!json || typeof json !== "object") return base;
  const obj = json as Record<string, unknown>;

  return {
    ...base,
    routes: coerceRoutes(obj.routes),
    controllers: coerceControllers(obj.controllers),
    models: coerceModels(obj.models),
    refs: coerceRefs(obj.refs),
  };
}

/** Shorter budget for the cheap inventory pass; more for detail/cross-unit passes. */
function passTimeout(pass: number): number {
  return pass === 1 ? 120 : 300;
}

// ── prompts ────────────────────────────────────────────────────────────────

function buildPrompt(unit: Unit, pass: number, context?: string): string {
  const files = unit.files.map((f) => `- ${f}`).join("\n");
  const preamble = context ? `${context}\n\n` : "";
  if (pass === 1) {
    return (
      `${preamble}Analyze ONLY these files (a "${unit.framework}" ${unit.kind} unit):\n${files}\n\n` +
      `List every HTTP route they declare. Respond with ONLY JSON:\n` +
      `{"routes":[{"method":"GET","path":"/path","controller":"CtrlName","action":"method"}]}\n` +
      `Use the empty string for unknown controller/action. Do not include prose.`
    );
  }
  return (
    `${preamble}Analyze ONLY these files (a "${unit.framework}" ${unit.kind} unit):\n${files}\n\n` +
    `Extract detail. Respond with ONLY JSON:\n` +
    `{"controllers":[{"classNameRef":"","filePath":"","namespace":"","methods":[],` +
    `"requestRules":{"action":["field:rule"]},"entityOperations":{}}],` +
    `"models":[{"className":"","tableName":"","fillable":[],"relationships":[],"casts":{},"scopes":[]}],` +
    `"refs":[{"from":"Ctrl","to":"Model","kind":"controller->model"}]}\n` +
    `Include only what these files show. Do not include prose.`
  );
}

// ── JSON extraction + defensive coercion ─────────────────────────────────────

/** Pull the first JSON object out of an LLM reply (handles ```json fences and prose). */
function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function strRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
}

function strListRecord(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) out[k] = strArray(val);
  return out;
}

function coerceRoutes(v: unknown): ParsedRoute[] {
  return asArray(v)
    .map((r) => ({
      method: str(r.method).toUpperCase(),
      path: str(r.path),
      controller: str(r.controller),
      action: str(r.action),
      middleware: strArray(r.middleware),
      prefix: str(r.prefix),
    }))
    .filter((r) => r.path !== "");
}

function coerceControllers(v: unknown): ParsedController[] {
  return asArray(v).map((c) => ({
    classNameRef: str(c.classNameRef),
    filePath: str(c.filePath),
    namespace: str(c.namespace),
    methods: strArray(c.methods),
    docblocks: strRecord(c.docblocks),
    requestRules: strListRecord(c.requestRules),
    entityOperations: (c.entityOperations && typeof c.entityOperations === "object"
      ? (c.entityOperations as ParsedController["entityOperations"])
      : {}),
  }));
}

function coerceModels(v: unknown): ParsedModel[] {
  return asArray(v).map((m) => ({
    className: str(m.className),
    tableName: str(m.tableName),
    fillable: strArray(m.fillable),
    relationships: strArray(m.relationships),
    casts: strRecord(m.casts),
    scopes: strArray(m.scopes),
  }));
}

function coerceRefs(v: unknown): FragmentRef[] {
  return asArray(v)
    .map((r) => ({ from: str(r.from), to: str(r.to), kind: str(r.kind) }))
    .filter((r) => r.from !== "" && r.to !== "");
}
