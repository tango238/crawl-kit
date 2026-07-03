// packages/verification/src/boundary.ts
//
// The system-boundary verification axis — the Core check, intent-free: does the
// RUNNING app behave the way the code was BUILT, boundary by boundary? A boundary
// (one route) carries a triple — Input / Display / Persistence — and we compare the
// as-built expectation (structure) against the as-run observation (behavior),
// anchored on the reconciler's route→entity→concept join.
//
//   Input        ParsedPage.formFields        vs  PageInfo.inputItems
//   Display      entity attributes            vs  PageInfo.displayItems
//   Persistence  Usecase.crud (C/U) + columns vs  dbProbe.wasValueSaved (registeredData)
//
// The killer check is `not-persisted`: a create/update boundary that accepts input
// but where nothing is observed to land. The strongest pass is `roundtrip-ok`.

import type { LayerNode } from "@crawl-kit/contract";
import { normalizeRoute } from "@crawl-kit/reconciler";

export interface BoundaryInput {
  route: string;
  entity?: string;
  /** seen in structure (a static route node)? */
  inStructure: boolean;
  /** seen in behavior (a crawled page)? */
  inBehavior: boolean;
  /** structure: declared input fields (formFields). */
  declaredInputs: string[];
  /** structure: domain events this route's handler emits (route→event trace). */
  events: string[];
  /** structure: does the boundary's CRUD write (Create/Update)? */
  persists: boolean;
  /** behavior: observed input fields. */
  observedInputs: string[];
  /** behavior: fields observed persisted; null = persistence not observed at all. */
  saved?: string[] | null;
}

export type BoundaryFacet = "input" | "persistence";
export type BoundaryKind =
  | "input-undeclared"
  | "input-missing"
  | "not-persisted"
  | "persistence-unobserved"
  | "roundtrip-ok";

export interface BoundaryFinding {
  route: string;
  facet: BoundaryFacet;
  kind: BoundaryKind;
  severity: "high" | "medium" | "low";
  ok: boolean;
  detail: string;
}

/** Per-route observation summary: which layers saw this route, and its finding tally. */
export interface BoundaryRoute {
  route: string;
  entity?: string;
  /** observed in structure (static route)? */
  structure: boolean;
  /** observed in behavior (crawled page)? */
  behavior: boolean;
  /** domain events this route emits (route→event trace) — shown at the boundary. */
  events: string[];
  problems: number;
  ok: number;
}

export interface BoundaryReport {
  generatedAt: string;
  boundaries: number;
  /** one entry per route, with where it was observed (structure / behavior). */
  routes: BoundaryRoute[];
  findings: BoundaryFinding[];
  summary: { problems: number; high: number; ok: number };
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** a field matches a known set if any known token equals or contains it (or vice versa). */
function matches(field: string, known: string[]): boolean {
  const f = norm(field);
  if (!f) return false;
  return known.some((k) => {
    const n = norm(k);
    return n.length >= 3 && f.length >= 3 && (n === f || n.includes(f) || f.includes(n));
  });
}

/** Verify one boundary's input/display/persistence triple. */
export function verifyBoundary(b: BoundaryInput): BoundaryFinding[] {
  const out: BoundaryFinding[] = [];

  // ---- Input: declared (structure) vs observed (behavior) --------------
  if (b.declaredInputs.length && b.observedInputs.length) {
    for (const obs of b.observedInputs) {
      if (!matches(obs, b.declaredInputs))
        out.push({ route: b.route, facet: "input", kind: "input-undeclared", severity: "medium", ok: false, detail: `実行時入力 "${obs}" が宣言(formFields)に無い` });
    }
    for (const dec of b.declaredInputs) {
      if (!matches(dec, b.observedInputs))
        out.push({ route: b.route, facet: "input", kind: "input-missing", severity: "low", ok: false, detail: `宣言入力 "${dec}" が画面に出ていない` });
    }
  }

  // ---- Persistence: the killer check ----------------------------------
  if (b.persists) {
    if (b.saved == null) {
      out.push({ route: b.route, facet: "persistence", kind: "persistence-unobserved", severity: "low", ok: false, detail: "C/U 境界だが保存が観測されていない（未検証）" });
    } else if (b.saved.length === 0) {
      out.push({ route: b.route, facet: "persistence", kind: "not-persisted", severity: "high", ok: false, detail: "入力を受けるが保存が観測されない（入れたのに残らない）" });
    } else {
      out.push({ route: b.route, facet: "persistence", kind: "roundtrip-ok", severity: "low", ok: true, detail: `保存を確認: ${b.saved.join(", ")}` });
    }
  }

  return out;
}

export function verifyBoundaries(boundaries: BoundaryInput[], now: string): BoundaryReport {
  const findings: BoundaryFinding[] = [];
  const routes: BoundaryRoute[] = [];
  for (const b of boundaries) {
    const fs = verifyBoundary(b);
    findings.push(...fs);
    routes.push({
      route: b.route,
      entity: b.entity,
      structure: b.inStructure,
      behavior: b.inBehavior,
      events: b.events,
      problems: fs.filter((f) => !f.ok).length,
      ok: fs.filter((f) => f.ok).length,
    });
  }
  const problems = findings.filter((f) => !f.ok);
  return {
    generatedAt: now,
    boundaries: boundaries.length,
    routes,
    findings,
    summary: { problems: problems.length, high: problems.filter((f) => f.severity === "high").length, ok: findings.filter((f) => f.ok).length },
  };
}

// ---------------------------------------------------------------------------
// Assemble BoundaryInput[] from the raw layer emits. A boundary is route-keyed:
// structure routes and behavior pages join on normalizeRoute (ADR-0004) — the
// same mechanical key the reconciler uses for the structure↔behavior edge. This
// is independent of concept matching (a matched aggregate's route still pairs
// with its observed page), which is exactly what the Core boundary check needs.
// ---------------------------------------------------------------------------

function raw(node: LayerNode): Record<string, unknown> {
  return (node.raw ?? {}) as Record<string, unknown>;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String((x as { label?: string; name?: string })?.name ?? (x as { label?: string })?.label ?? ""))).filter(Boolean) : [];
}

export function assembleBoundaries(structureNodes: LayerNode[], behaviorNodes: LayerNode[]): BoundaryInput[] {
  const byKey = new Map<string, BoundaryInput>();
  const ensure = (routeKey: string): BoundaryInput =>
    byKey.get(normalizeRoute(routeKey)) ??
    byKey.set(normalizeRoute(routeKey), { route: routeKey, inStructure: false, inBehavior: false, declaredInputs: [], events: [], persists: false, observedInputs: [], saved: null }).get(normalizeRoute(routeKey))!;

  for (const n of structureNodes) {
    if (!n.nodeId.startsWith("structure:route/")) continue;
    const r = raw(n);
    const b = ensure(n.route ?? n.localName);
    b.inStructure = true;
    b.declaredInputs = strList(r.inputs);
    b.events = strList(r.events);
    b.entity = typeof r.entity === "string" ? r.entity : b.entity;
    const crud = strList(r.crud);
    b.persists = crud.includes("C") || crud.includes("U");
  }
  for (const n of behaviorNodes) {
    if (!(n.nodeId.startsWith("behavior:page/") || n.nodeId.startsWith("behavior:tx/"))) continue;
    const r = raw(n);
    const b = ensure(n.route ?? n.localName);
    b.inBehavior = true;
    b.observedInputs = strList(r.inputItems);
    if (r.saved !== undefined) b.saved = strList(r.saved);
  }
  return [...byKey.values()];
}

export function buildBoundaryReport(structureNodes: LayerNode[], behaviorNodes: LayerNode[], now: string): BoundaryReport {
  return verifyBoundaries(assembleBoundaries(structureNodes, behaviorNodes), now);
}
