// packages/structure/src/analyze/merge.ts
//
// Task 4 of the incremental/distributed analyzer: the SYNC barrier. Independently-parsed
// unit fragments are folded into one structure model — routes deduped by the same
// normalizeRoute key the reconciler joins on (so a route seen in two units becomes one),
// controllers/models unioned by identity, and cross-unit references resolved (a route that
// names a controller present in another unit gets a derived route->controller edge).

import { normalizeRoute } from "@crawl-kit/reconciler";
import type { FragmentRef, StructureFragment } from "./fragments.js";
import type { ParsedController, ParsedModel, ParsedRoute } from "./source-parser.js";

export interface MergedStructure {
  routes: ParsedRoute[];
  controllers: ParsedController[];
  models: ParsedModel[];
  refs: FragmentRef[];
}

/** Fold unit fragments into one structure model (dedup + union + cross-unit ref resolution). */
export function mergeFragments(frags: StructureFragment[]): MergedStructure {
  const routes = mergeRoutes(frags.flatMap((f) => f.routes));
  const controllers = mergeControllers(frags.flatMap((f) => f.controllers));
  const models = mergeModels(frags.flatMap((f) => f.models));
  const refs = resolveRefs(frags.flatMap((f) => f.refs), routes, controllers);
  return { routes, controllers, models, refs };
}

// ── routes ───────────────────────────────────────────────────────────────────

function mergeRoutes(routes: ParsedRoute[]): ParsedRoute[] {
  const byKey = new Map<string, ParsedRoute>();
  for (const r of routes) {
    const key = normalizeRoute(`${r.method} ${r.path}`);
    // canonicalize the stored path to a pattern (id-shaped segments → :id) so a deduped
    // route always reads as "/users/:id", never a concrete "/users/1" from one sample.
    const canonical = { ...r, path: templatize(r.path) };
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...canonical, middleware: [...r.middleware] });
      continue;
    }
    byKey.set(key, {
      method: prev.method,
      path: prev.path,
      controller: prev.controller || r.controller,
      action: prev.action || r.action,
      prefix: prev.prefix || r.prefix,
      middleware: union(prev.middleware, r.middleware),
    });
  }
  return [...byKey.values()].sort(byRouteKey);
}

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^[0-9a-f]{16,}$/i;

/** Replace id-shaped segments with :id, preserving case of fixed segments (unlike normalizeRoute). */
function templatize(path: string): string {
  const [pathOnly] = path.split(/[?#]/);
  const segs = (pathOnly ?? "").split("/").filter((s) => s.length > 0).map((s) => {
    if (s.startsWith(":")) return s;
    if (s.startsWith("{") && s.endsWith("}")) return ":id";
    if (NUMERIC.test(s) || UUID.test(s) || HEX_ID.test(s)) return ":id";
    return s;
  });
  return segs.length === 0 ? "/" : `/${segs.join("/")}`;
}

function byRouteKey(a: ParsedRoute, b: ParsedRoute): number {
  const ka = `${a.method} ${a.path}`;
  const kb = `${b.method} ${b.path}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// ── controllers ────────────────────────────────────────────────────────────

function mergeControllers(controllers: ParsedController[]): ParsedController[] {
  const byName = new Map<string, ParsedController>();
  for (const c of controllers) {
    if (!c.classNameRef) continue;
    const prev = byName.get(c.classNameRef);
    if (!prev) {
      byName.set(c.classNameRef, clone(c));
      continue;
    }
    byName.set(c.classNameRef, {
      classNameRef: c.classNameRef,
      filePath: prev.filePath || c.filePath,
      namespace: prev.namespace || c.namespace,
      methods: union(prev.methods, c.methods),
      docblocks: { ...prev.docblocks, ...c.docblocks },
      requestRules: { ...prev.requestRules, ...c.requestRules },
      entityOperations: { ...prev.entityOperations, ...c.entityOperations },
    });
  }
  return [...byName.values()].sort((a, b) => (a.classNameRef < b.classNameRef ? -1 : 1));
}

function clone(c: ParsedController): ParsedController {
  return {
    ...c,
    methods: [...c.methods],
    docblocks: { ...c.docblocks },
    requestRules: { ...c.requestRules },
    entityOperations: { ...c.entityOperations },
  };
}

// ── models ───────────────────────────────────────────────────────────────────

function mergeModels(models: ParsedModel[]): ParsedModel[] {
  const byName = new Map<string, ParsedModel>();
  for (const m of models) {
    if (!m.className) continue;
    const prev = byName.get(m.className);
    if (!prev) {
      byName.set(m.className, { ...m, fillable: [...m.fillable], relationships: [...m.relationships], scopes: [...m.scopes], casts: { ...m.casts } });
      continue;
    }
    byName.set(m.className, {
      className: m.className,
      tableName: prev.tableName || m.tableName,
      fillable: union(prev.fillable, m.fillable),
      relationships: union(prev.relationships, m.relationships),
      casts: { ...prev.casts, ...m.casts },
      scopes: union(prev.scopes, m.scopes),
    });
  }
  return [...byName.values()].sort((a, b) => (a.className < b.className ? -1 : 1));
}

// ── refs (cross-unit resolution) ──────────────────────────────────────────────

function resolveRefs(
  explicit: FragmentRef[],
  routes: ParsedRoute[],
  controllers: ParsedController[],
): FragmentRef[] {
  const out = new Map<string, FragmentRef>();
  const add = (r: FragmentRef): void => {
    if (!r.from || !r.to) return;
    out.set(`${r.from}|${r.to}|${r.kind}`, r);
  };

  for (const r of explicit) add(r);

  // derive route->controller edges for routes whose controller exists among merged units
  const known = new Set(controllers.map((c) => c.classNameRef));
  for (const route of routes) {
    if (route.controller && known.has(route.controller)) {
      add({ from: `${route.method} ${route.path}`, to: route.controller, kind: "route->controller" });
    }
  }

  return [...out.values()].sort((a, b) => {
    const ka = `${a.kind}|${a.from}|${a.to}`;
    const kb = `${b.kind}|${b.from}|${b.to}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ── shared ─────────────────────────────────────────────────────────────────

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}
