// packages/structure/src/analyze/laravel-routes.ts
//
// Deterministic Laravel route parser — the PRIMARY path for pass-1 route inventory on
// laravel "routes" units. Route files are mechanically parseable, so we tokenize them
// directly instead of paying for a (slow, non-deterministic) LLM round-trip. No PHP
// runtime: a comment-stripping character scanner tracks brace depth to stack group
// prefixes/middleware, and reads each `Route::<verb>(...)` / resource / group statement.
//
// Design notes:
//   - `any`  → a single route with method "ANY" (one leaf, mirrors one source line). Route
//     method strings are free-form downstream, so "ANY" is kept verbatim.
//   - `match([...])` → one route per listed method.
//   - resource/apiResource → the standard Laravel route set (see RESOURCE_ACTIONS), honoring
//     chained ->only([...]) / ->except([...]). `update` expands to BOTH PUT and PATCH.
//   - group prefixes STACK across nesting via a brace-depth stack; both the array form
//     (Route::group([...], fn)) and the fluent form (Route::prefix('x')->group(fn)) are read.
//   - mount prefix: routes files are mounted under a prefix by the RouteServiceProvider,
//     which is NOT part of a routes unit. We therefore do NOT invent it — paths come out as
//     written in the file. Callers that statically know the mount prefix pass `filePrefix`.
//
// Never throws: an unparseable statement is skipped; the rest of the file still parses.

import type { ParsedRoute } from "./source-parser.js";

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "any"]);
const RESOURCE_KINDS = new Set(["resource", "apiResource"]);
const MODIFIER_NAMES = new Set(["middleware", "prefix", "name", "namespace", "domain", "as"]);

/** Standard Laravel resource actions → the routes they register. */
interface ResourceAction {
  name: string;
  entries: { method: string; suffix: string }[];
  apiOnly: boolean; // excluded from apiResource (create/edit are HTML-form routes)
}
const RESOURCE_ACTIONS: ResourceAction[] = [
  { name: "index", entries: [{ method: "GET", suffix: "" }], apiOnly: false },
  { name: "create", entries: [{ method: "GET", suffix: "/create" }], apiOnly: true },
  { name: "store", entries: [{ method: "POST", suffix: "" }], apiOnly: false },
  { name: "show", entries: [{ method: "GET", suffix: "/{id}" }], apiOnly: false },
  { name: "edit", entries: [{ method: "GET", suffix: "/{id}/edit" }], apiOnly: true },
  {
    name: "update",
    entries: [
      { method: "PUT", suffix: "/{id}" },
      { method: "PATCH", suffix: "/{id}" },
    ],
    apiOnly: false,
  },
  { name: "destroy", entries: [{ method: "DELETE", suffix: "/{id}" }], apiOnly: false },
];

interface GroupFrame {
  prefix: string; // normalized (no leading/trailing slash)
  middleware: string[];
}

interface GroupAttrs {
  prefix: string;
  middleware: string[];
}

interface Segment {
  name: string;
  args: string; // raw text inside the (...) of this call
}

/**
 * Parse a Laravel routes file into a flat route list. `filePrefix` (e.g. "api/v1") is
 * prepended to every path when the caller statically knows the file's mount prefix.
 */
export function parseLaravelRoutes(source: string, filePrefix = ""): ParsedRoute[] {
  const src = stripComments(source);
  const n = src.length;
  const routes: ParsedRoute[] = [];
  const stack: GroupFrame[] = []; // one frame per open brace (neutral for non-group braces)
  let pending: GroupAttrs | null = null;
  const basePrefix = normalizePrefix(filePrefix);

  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === "'" || c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (c === "{") {
      stack.push(pending ? { prefix: pending.prefix, middleware: pending.middleware } : { prefix: "", middleware: [] });
      pending = null;
      i++;
      continue;
    }
    if (c === "}") {
      stack.pop();
      i++;
      continue;
    }
    if (isRouteToken(src, i)) {
      const chain = readChain(src, i);
      if (chain.isGroup) {
        pending = groupAttrsFrom(chain.segments, chain.groupArrayText);
        if (chain.bodyBrace >= 0) {
          i = chain.bodyBrace; // next iteration consumes the '{' and pushes the frame
          continue;
        }
        pending = null; // malformed group (no closure body found): skip it
        i = chain.end;
        continue;
      }
      emitTerminal(chain.segments, stack, basePrefix, routes);
      i = chain.end;
      continue;
    }
    i++;
  }

  return routes;
}

// ── statement / chain reading ────────────────────────────────────────────────

interface ChainResult {
  segments: Segment[];
  isGroup: boolean;
  groupArrayText: string; // the [...] attrs array for the array form (may be "")
  bodyBrace: number; // index of the group closure's opening '{' (group form only)
  end: number; // index just past the statement (terminal form) — where scanning resumes
}

/** Read a `Route::...` chain from `start`. Stops at the terminating `;` or, for a group,
 *  at the closure body's `{` (so the body is scanned normally by the main loop). */
function readChain(src: string, start: number): ChainResult {
  const n = src.length;
  let i = start + "Route".length;
  const segments: Segment[] = [];

  while (i < n) {
    i = skipWs(src, i);
    // connector: "::" or "->"
    if (src[i] === ":" && src[i + 1] === ":") i += 2;
    else if (src[i] === "-" && src[i + 1] === ">") i += 2;
    else break;
    i = skipWs(src, i);

    const nameStart = i;
    while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
    const name = src.slice(nameStart, i);
    if (name === "") break;

    i = skipWs(src, i);
    if (src[i] !== "(") {
      // property/const access without call — not something we model; stop here.
      break;
    }

    if (name === "group") {
      let j = skipWs(src, i + 1);
      let arrayText = "";
      if (src[j] === "[") {
        const close = matchDelim(src, j);
        arrayText = src.slice(j, close + 1);
        j = close + 1;
      }
      const brace = indexOfUnquoted(src, j, "{");
      return { segments, isGroup: true, groupArrayText: arrayText, bodyBrace: brace, end: brace >= 0 ? brace : i + 1 };
    }

    const close = matchDelim(src, i);
    segments.push({ name, args: src.slice(i + 1, close) });
    i = close + 1;
    i = skipWs(src, i);
    if (src[i] === ";") return { segments, isGroup: false, groupArrayText: "", bodyBrace: -1, end: i + 1 };
    // otherwise loop to read the next ->connector (or break if none)
  }

  return { segments, isGroup: false, groupArrayText: "", bodyBrace: -1, end: Math.max(i, start + 6) };
}

// ── terminal route emission ──────────────────────────────────────────────────

function emitTerminal(
  segments: Segment[],
  stack: GroupFrame[],
  basePrefix: string,
  out: ParsedRoute[],
): void {
  const verbIdx = segments.findIndex(
    (s) => HTTP_VERBS.has(s.name.toLowerCase()) || RESOURCE_KINDS.has(s.name) || s.name === "match",
  );
  if (verbIdx === -1) return; // e.g. Route::pattern(...), Route::bind(...) — not a leaf route

  const verb = segments[verbIdx]!;
  const inlinePrefix = collect(segments, "prefix").map(stripQuotes).join("/");
  const inlineMiddleware = collect(segments, "middleware").flatMap(parseMiddlewareValue);
  const framePrefixes = stack.map((f) => f.prefix);
  const stackMiddleware = stack.flatMap((f) => f.middleware);
  const middleware = dedupe([...stackMiddleware, ...inlineMiddleware]);
  const prefixSegs = [basePrefix, ...framePrefixes, inlinePrefix];

  const name = verb.name.toLowerCase();

  if (RESOURCE_KINDS.has(verb.name)) {
    emitResource(verb, segments.slice(verbIdx + 1), prefixSegs, middleware, out);
    return;
  }

  if (name === "match") {
    const args = splitArgs(verb.args);
    const methods = parseStringArray(args[0] ?? "").map((m) => m.toUpperCase());
    const path = stripQuotes(args[1] ?? "");
    const handler = parseHandler(args[2] ?? "");
    for (const method of methods) {
      out.push(makeRoute(method, joinPath([...prefixSegs, path]), handler, middleware, prefixSegs));
    }
    return;
  }

  // plain HTTP verb (get/post/put/patch/delete/options/head/any)
  const args = splitArgs(verb.args);
  const path = stripQuotes(args[0] ?? "");
  const handler = parseHandler(args[1] ?? "");
  const method = name === "any" ? "ANY" : name.toUpperCase();
  out.push(makeRoute(method, joinPath([...prefixSegs, path]), handler, middleware, prefixSegs));
}

function emitResource(
  verb: Segment,
  trailing: Segment[],
  prefixSegs: string[],
  middleware: string[],
  out: ParsedRoute[],
): void {
  const args = splitArgs(verb.args);
  const resourcePath = stripQuotes(args[0] ?? "");
  const handler = parseHandler(args[1] ?? "");
  const isApi = verb.name === "apiResource";

  const only = new Set(collect(trailing, "only").flatMap(parseStringArray));
  const except = new Set(collect(trailing, "except").flatMap(parseStringArray));

  for (const action of RESOURCE_ACTIONS) {
    if (isApi && action.apiOnly) continue;
    if (only.size > 0 && !only.has(action.name)) continue;
    if (except.has(action.name)) continue;
    for (const entry of action.entries) {
      const path = joinPath([...prefixSegs, resourcePath + entry.suffix]);
      out.push(makeRoute(entry.method, path, { ...handler, action: action.name }, middleware, prefixSegs));
    }
  }
}

function makeRoute(
  method: string,
  path: string,
  handler: { controller: string; action: string },
  middleware: string[],
  prefixSegs: string[],
): ParsedRoute {
  return {
    method,
    path,
    controller: handler.controller,
    action: handler.action,
    middleware,
    prefix: prefixSegs.filter((p) => p !== "").join("/"),
  };
}

// ── attribute parsing ────────────────────────────────────────────────────────

function groupAttrsFrom(segments: Segment[], arrayText: string): GroupAttrs {
  const attrs: GroupAttrs = { prefix: "", middleware: [] };

  // fluent form: Route::prefix('x')->middleware([...])->group(...)
  const fluentPrefix = collect(segments, "prefix").map(stripQuotes).filter(Boolean);
  if (fluentPrefix.length > 0) attrs.prefix = normalizePrefix(fluentPrefix.join("/"));
  attrs.middleware.push(...collect(segments, "middleware").flatMap(parseMiddlewareValue));

  // array form: Route::group(['prefix' => 'x', 'middleware' => [...]], fn)
  if (arrayText) {
    const record = parseAttrArray(arrayText);
    if (record.prefix !== undefined) attrs.prefix = normalizePrefix(record.prefix);
    if (record.middleware !== undefined) attrs.middleware.push(...record.middleware);
  }

  attrs.middleware = dedupe(attrs.middleware);
  return attrs;
}

/** Parse `['prefix' => 'x', 'middleware' => [...], ...]` into the keys we care about. */
function parseAttrArray(arrayText: string): { prefix?: string; middleware?: string[] } {
  const inner = stripOuter(arrayText, "[", "]");
  const out: { prefix?: string; middleware?: string[] } = {};
  for (const item of splitArgs(inner)) {
    const arrow = topLevelArrow(item);
    if (arrow === -1) continue;
    const key = stripQuotes(item.slice(0, arrow).trim());
    const value = item.slice(arrow + 2).trim();
    if (key === "prefix") out.prefix = stripQuotes(value);
    else if (key === "middleware") out.middleware = parseMiddlewareValue(value);
  }
  return out;
}

function parseMiddlewareValue(raw: string): string[] {
  const v = raw.trim();
  if (v === "") return [];
  if (v.startsWith("[")) return parseStringArray(v);
  return [stripQuotes(v)].filter(Boolean);
}

/** Extract the quoted strings from a `[...]` array or a bare comma list. */
function parseStringArray(raw: string): string[] {
  const v = raw.trim();
  const inner = v.startsWith("[") ? stripOuter(v, "[", "]") : v;
  return splitArgs(inner)
    .map(stripQuotes)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── handler parsing ──────────────────────────────────────────────────────────

function parseHandler(raw: string): { controller: string; action: string } {
  const v = raw.trim();
  if (v === "") return { controller: "", action: "" };
  if (/^(static\s+)?function\b/.test(v) || /^fn\b/.test(v)) return { controller: "", action: "closure" };

  if (v.startsWith("[")) {
    const parts = splitArgs(stripOuter(v, "[", "]"));
    const controller = classBasename(parts[0] ?? "");
    const action = stripQuotes(parts[1] ?? "") || "__invoke";
    return { controller, action };
  }

  const s = stripQuotes(v);
  if (s.includes("@")) {
    const at = s.indexOf("@");
    return { controller: classBasename(s.slice(0, at)), action: s.slice(at + 1).trim() };
  }
  // 'SingleActionController' string OR Controller::class
  return { controller: classBasename(s || v), action: "__invoke" };
}

/** Last class-name segment of a controller reference (drops namespace, ::class, leading \). */
function classBasename(ref: string): string {
  let s = stripQuotes(ref.trim());
  s = s.replace(/::class$/, "").trim();
  s = s.replace(/^\\+/, "");
  const slash = s.lastIndexOf("\\");
  return slash === -1 ? s : s.slice(slash + 1);
}

// ── path helpers ─────────────────────────────────────────────────────────────

function joinPath(parts: string[]): string {
  const segs: string[] = [];
  for (const part of parts) {
    for (const s of part.split("/")) if (s !== "") segs.push(s);
  }
  return "/" + segs.join("/");
}

function normalizePrefix(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

// ── low-level scanners ───────────────────────────────────────────────────────

/** Remove PHP line comments (// and #) and block comments, preserving string literals. */
function stripComments(src: string): string {
  const n = src.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === "'" || c === '"') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue; // leave the newline for the next iteration
    }
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " "; // avoid token merge across the removed block
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Given `src[i]` is a quote, return the index just past the closing quote. */
function skipString(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  const n = src.length;
  while (j < n) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === q) return j + 1;
    j++;
  }
  return n;
}

function skipWs(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i]!)) i++;
  return i;
}

/** `src[openIdx]` is one of ( [ { — return the index of its matching close. */
function matchDelim(src: string, openIdx: number): number {
  const open = src[openIdx]!;
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  const n = src.length;
  let depth = 0;
  let i = openIdx;
  while (i < n) {
    const c = src[i]!;
    if (c === "'" || c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return n - 1;
}

/** First index of `target` at or after `from`, skipping string literals. */
function indexOfUnquoted(src: string, from: number, target: string): number {
  const n = src.length;
  let i = from;
  while (i < n) {
    const c = src[i]!;
    if (c === "'" || c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (c === target) return i;
    i++;
  }
  return -1;
}

/** Split `text` on top-level commas, skipping strings and nested brackets. */
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const end = skipString(text, i);
      cur += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts;
}

/** Index of the top-level `=>` in an array item, or -1. */
function topLevelArrow(item: string): number {
  let depth = 0;
  let i = 0;
  while (i < item.length) {
    const c = item[i]!;
    if (c === "'" || c === '"') {
      i = skipString(item, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "=" && item[i + 1] === ">") return i;
    i++;
  }
  return -1;
}

function isRouteToken(src: string, i: number): boolean {
  if (src.slice(i, i + 5) !== "Route") return false;
  if (!(src[i + 5] === ":" && src[i + 6] === ":")) return false;
  const prev = i > 0 ? src[i - 1]! : "";
  return !/[A-Za-z0-9_]/.test(prev); // a leading "\" (facade import) is fine
}

// ── small utilities ──────────────────────────────────────────────────────────

function collect(segments: Segment[], name: string): string[] {
  return segments.filter((s) => s.name === name).map((s) => s.args);
}

function stripQuotes(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

function stripOuter(raw: string, open: string, close: string): string {
  const v = raw.trim();
  const start = v.indexOf(open);
  const end = v.lastIndexOf(close);
  if (start === -1 || end === -1 || end <= start) return v;
  return v.slice(start + 1, end);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

// keep MODIFIER_NAMES referenced (documents the set of chain modifiers we recognize)
void MODIFIER_NAMES;
