// packages/viewer/src/diff-view.ts
//
// The side-by-side diff model: INTENT is the index. For each intent event and state
// transition we look for the matching structure item and mark it aligned or a ⚠ gap.
// Items that exist in code but not in intent are NOT defects — they surface separately
// as "candidates".
//
// The event×route table (`eventRoutes`) is a separate, verification-side view: per event
// it lists the route(s) that emit it (the structure route→event trace) and shows
// intent / structure / behavior side by side. The behavior signal is derived by REVERSE
// LOOKUP — an event is "observed" when one of its emitting routes was exercised at
// runtime (its path appears among the crawled pages/transitions). This is inference, not
// a direct event observation, and is marked as such.
//
// Pure: takes plain axis objects, returns a render-ready model. No I/O — the CLI wires
// the inputs.

export interface IntentEvent {
  name: string;
  aggregate?: string;
  context?: string;
  trigger?: string;
  properties?: string[];
}
export interface IntentTransition {
  aggregate: string;
  context?: string;
  from: string;
  to: string;
  trigger?: string | null;
  event?: string | null;
}
export interface IntentAxis {
  events?: IntentEvent[];
  stateTransitions?: IntentTransition[];
}

export interface StructureEventLike {
  name: string;
  aggregate?: string;
  trigger?: string;
  source?: string;
}
export interface StructureTransitionLike {
  aggregate?: string;
  from?: string | null;
  to: string;
  trigger?: string | null;
  source?: string;
}
export interface StructureAxis {
  events?: StructureEventLike[];
  stateTransitions?: StructureTransitionLike[];
}

export interface BehaviorEventLike {
  name: string;
  ref?: string;
}
export interface BehaviorTransitionLike {
  from?: string | null;
  to: string;
  trigger?: string | null;
  ref?: string;
}
export interface BehaviorAxis {
  events?: BehaviorEventLike[];
  stateTransitions?: BehaviorTransitionLike[];
}

export type Status = "aligned" | "gap";

export interface Cell {
  present: boolean;
  /** the shape as it appears in this layer (for the side-by-side compare). */
  shape?: string;
  /** provenance / ref (source location, trigger, …). */
  ref?: string;
}

/** intent↔structure diff row for an event or transition (behavior is shown elsewhere). */
export interface DiffRow {
  kind: "event" | "transition";
  label: string;
  aggregate?: string;
  intent: Cell;
  structure: Cell;
  status: Status; // structure perspective (the intent↔structure diff)
  /**
   * event rows only: the resolved event×route rows that emit this event, pre-joined
   * server-side so the browser never re-normalizes to re-join `eventRoutes` (mirrors
   * traffic-model.ts's joinTrafficRoutes). Only rows with a concrete `route` — an event
   * with no emitting route gets `[]`.
   */
  routes?: EventRouteRow[];
}

export interface Candidate {
  layer: "structure" | "behavior";
  label: string;
  ref?: string;
}

/** A route and the domain events its handler emits (← structure route→event trace). */
export interface RouteEventLink {
  /** "METHOD path", e.g. "POST /reservations". */
  route: string;
  events: string[];
}

/**
 * One (event × route) row for the verification-side event table. intent/structure are
 * event-level (does the event exist in that layer?); behavior is route-level — observed
 * when this row's emitting route was exercised at runtime (reverse lookup). Events with
 * no emitting route get a single row with `route` undefined.
 */
export interface EventRouteRow {
  event: string;
  aggregate?: string;
  route?: string;
  intent: boolean;
  structure: boolean;
  /** behavior observation inferred from the route: observed iff the route ran at runtime. */
  behavior: { observed: boolean; via?: "route" };
}

/** An adjudicated verification finding (← packages/verification VerificationReport). */
export interface VerificationFinding {
  conceptId: string;
  category: string;
  severity: "high" | "medium" | "low";
  classification: "bug" | "unnecessary" | "uncertain";
  expected: string;
  actual: string;
  location: string;
  confidence: number;
}

/** A system-boundary finding (← packages/verification BoundaryReport). */
export interface BoundaryFindingView {
  route: string;
  facet: "input" | "persistence";
  kind: string;
  severity: "high" | "medium" | "low";
  ok: boolean;
  detail: string;
}

/** Per-route observation: which layers saw this route, plus the events it emits. */
export interface BoundaryRouteView {
  route: string;
  entity?: string;
  structure: boolean;
  behavior: boolean;
  /** domain events this route emits (route→event trace) — shown at the boundary. */
  events: string[];
  problems: number;
  ok: number;
}

export interface DiffViewInputs {
  findings?: VerificationFinding[];
  boundaries?: BoundaryFindingView[];
  boundaryRoutes?: BoundaryRouteView[];
  /** route→event links from structure (drives the event×route table's routes). */
  routeEvents?: RouteEventLink[];
  /** route keys observed at runtime ("METHOD path" or path) — drives behavior inference. */
  observedRoutes?: string[];
}

export interface DiffView {
  events: DiffRow[];
  transitions: DiffRow[];
  candidates: { events: Candidate[]; transitions: Candidate[] };
  /** event × route, with intent/structure/behavior side by side (verification view). */
  eventRoutes: EventRouteRow[];
  /** adjudicated verification findings on the reconciled model, worst first. */
  findings: VerificationFinding[];
  /** system-boundary findings (input/persistence), problems first. */
  boundaries: BoundaryFindingView[];
  /** per-route observation summary (where each route was observed: structure/behavior). */
  boundaryRoutes: BoundaryRouteView[];
  stats: {
    events: { total: number; aligned: number; gap: number };
    transitions: { total: number; aligned: number; gap: number };
    candidates: number;
    eventRoutes: { total: number; observed: number };
    findings: { total: number; bug: number; uncertain: number; unnecessary: number };
    boundaries: { total: number; problems: number; high: number; ok: number };
  };
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** path part of a "METHOD path" route key (or the whole string when no method prefix). */
const pathOf = (route: string): string => {
  const i = route.indexOf(" ");
  return i >= 0 ? route.slice(i + 1) : route;
};
/** normalize a route path for cross-layer matching (lowercase, drop trailing slash). */
const normPath = (p: string): string => p.toLowerCase().replace(/\/+$/, "") || "/";

function tally(rows: DiffRow[]): { total: number; aligned: number; gap: number } {
  const aligned = rows.filter((r) => r.status === "aligned").length;
  return { total: rows.length, aligned, gap: rows.length - aligned };
}

/**
 * Build the diff view. The event/transition tables are the intent↔structure diff only
 * (behavior lives in the event×route table). `routeEvents` + `observedRoutes` drive the
 * event×route table and its route-based behavior inference.
 */
export function buildDiffView(
  intent: IntentAxis,
  structure: StructureAxis,
  behavior: BehaviorAxis = {},
  inputs: DiffViewInputs = {},
): DiffView {
  const { findings = [], boundaries = [], boundaryRoutes = [], routeEvents = [], observedRoutes = [] } = inputs;

  const sEvents = structure.events ?? [];
  const sTrans = structure.stateTransitions ?? [];
  const bEvents = behavior.events ?? [];
  const bTrans = behavior.stateTransitions ?? [];
  const intentEvents = intent.events ?? [];
  const intentTrans = intent.stateTransitions ?? [];

  // ---- events: match intent ↔ structure by name -----------------------
  const sEventByName = new Map(sEvents.map((e) => [norm(e.name), e]));
  const bEventByName = new Map(bEvents.map((e) => [norm(e.name), e]));
  const matchedSEvents = new Set<string>();
  const matchedBEvents = new Set<string>();
  const events: DiffRow[] = intentEvents.map((e) => {
    const key = norm(e.name);
    const s = sEventByName.get(key);
    if (s) matchedSEvents.add(key);
    if (bEventByName.has(key)) matchedBEvents.add(key);
    return {
      kind: "event" as const,
      label: e.name,
      aggregate: e.aggregate,
      intent: { present: true, shape: e.name, ref: e.trigger ?? undefined },
      structure: s ? { present: true, shape: s.name, ref: s.source } : { present: false },
      status: s ? "aligned" : "gap",
    };
  });

  // ---- transitions: match by target state (sources rarely know `from`) --
  const byTo = <T extends { to: string }>(xs: T[]): Map<string, T> => {
    const m = new Map<string, T>();
    for (const x of xs) if (!m.has(norm(x.to))) m.set(norm(x.to), x);
    return m;
  };
  const sTransByTo = byTo(sTrans);
  const bTransByTo = byTo(bTrans);
  const matchedSTrans = new Set<string>();
  const matchedBTrans = new Set<string>();
  const transitions: DiffRow[] = intentTrans.map((t) => {
    const key = norm(t.to);
    const s = sTransByTo.get(key);
    if (s) matchedSTrans.add(key);
    if (bTransByTo.has(key)) matchedBTrans.add(key);
    const intentShape = `${t.from} → ${t.to}`;
    return {
      kind: "transition" as const,
      label: intentShape,
      aggregate: t.aggregate,
      intent: { present: true, shape: intentShape, ref: t.trigger ?? t.event ?? undefined },
      structure: s ? { present: true, shape: `${s.from ?? "?"} → ${s.to}`, ref: s.source } : { present: false },
      status: s ? "aligned" : "gap",
    };
  });

  // ---- candidates: in code/runtime, not in intent ----------------------
  const candidateEvents: Candidate[] = [
    ...sEvents.filter((e) => !matchedSEvents.has(norm(e.name))).map((e) => ({ layer: "structure" as const, label: e.name, ref: e.source })),
    ...bEvents.filter((e) => !matchedBEvents.has(norm(e.name))).map((e) => ({ layer: "behavior" as const, label: e.name, ref: e.ref })),
  ];
  const candidateTrans: Candidate[] = [
    ...sTrans.filter((t) => !matchedSTrans.has(norm(t.to))).map((t) => ({ layer: "structure" as const, label: `${t.aggregate ?? "?"}: ${t.from ?? "?"} → ${t.to}`, ref: t.source })),
    ...bTrans.filter((t) => !matchedBTrans.has(norm(t.to))).map((t) => ({ layer: "behavior" as const, label: `${t.from ?? "?"} → ${t.to}`, ref: t.ref })),
  ];

  // ---- event × route (verification view, behavior via route reverse-lookup) ----
  const intentEvByName = new Map(intentEvents.map((e) => [norm(e.name), e]));
  const allEventNames = new Map<string, { name: string; aggregate?: string }>();
  for (const e of intentEvents) allEventNames.set(norm(e.name), { name: e.name, aggregate: e.aggregate });
  for (const e of sEvents) if (!allEventNames.has(norm(e.name))) allEventNames.set(norm(e.name), { name: e.name, aggregate: e.aggregate });

  const routesByEvent = new Map<string, string[]>();
  for (const re of routeEvents) {
    for (const ev of re.events) {
      const k = norm(ev);
      (routesByEvent.get(k) ?? routesByEvent.set(k, []).get(k)!).push(re.route);
    }
  }
  const observedPaths = new Set(observedRoutes.map((r) => normPath(pathOf(r))));

  const eventRoutes: EventRouteRow[] = [];
  for (const [key, { name, aggregate }] of allEventNames) {
    const intentPresent = intentEvByName.has(key);
    const structurePresent = sEventByName.has(key);
    const routes = [...new Set(routesByEvent.get(key) ?? [])];
    if (routes.length === 0) {
      eventRoutes.push({ event: name, aggregate, intent: intentPresent, structure: structurePresent, behavior: { observed: false } });
    } else {
      for (const route of routes) {
        const observed = observedPaths.has(normPath(pathOf(route)));
        eventRoutes.push({
          event: name,
          aggregate,
          route,
          intent: intentPresent,
          structure: structurePresent,
          behavior: observed ? { observed: true, via: "route" } : { observed: false },
        });
      }
    }
  }

  // pre-join each event's emitting routes onto its event DiffRow (server-side, mirroring
  // traffic-model.ts's joinTrafficRoutes) so the browser reads `row.routes` directly and
  // never re-normalizes event names to re-join `eventRoutes`. Only concrete-route rows.
  const eventRoutesByKey = new Map<string, EventRouteRow[]>();
  for (const r of eventRoutes) {
    if (r.route === undefined) continue;
    const k = norm(r.event);
    (eventRoutesByKey.get(k) ?? eventRoutesByKey.set(k, []).get(k)!).push(r);
  }
  const eventRows: DiffRow[] = events.map((row) => ({
    ...row,
    routes: eventRoutesByKey.get(norm(row.label)) ?? [],
  }));

  // findings worst-first: bug > uncertain > unnecessary, then high > medium > low.
  const classRank = { bug: 0, uncertain: 1, unnecessary: 2 } as const;
  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  const sortedFindings = [...findings].sort(
    (a, b) => classRank[a.classification] - classRank[b.classification] || sevRank[a.severity] - sevRank[b.severity],
  );
  const findingStats = {
    total: findings.length,
    bug: findings.filter((f) => f.classification === "bug").length,
    uncertain: findings.filter((f) => f.classification === "uncertain").length,
    unnecessary: findings.filter((f) => f.classification === "unnecessary").length,
  };

  // boundary findings: problems first (high → low), ok rows last.
  const sortedBoundaries = [...boundaries].sort(
    (a, b) => Number(a.ok) - Number(b.ok) || sevRank[a.severity] - sevRank[b.severity],
  );
  const boundaryStats = {
    total: boundaries.length,
    problems: boundaries.filter((b) => !b.ok).length,
    high: boundaries.filter((b) => !b.ok && b.severity === "high").length,
    ok: boundaries.filter((b) => b.ok).length,
  };

  return {
    events: eventRows,
    transitions,
    candidates: { events: candidateEvents, transitions: candidateTrans },
    eventRoutes,
    findings: sortedFindings,
    boundaries: sortedBoundaries,
    boundaryRoutes: [...boundaryRoutes].sort((a, b) => b.problems - a.problems || a.route.localeCompare(b.route)),
    stats: {
      events: tally(events),
      transitions: tally(transitions),
      candidates: candidateEvents.length + candidateTrans.length,
      eventRoutes: { total: eventRoutes.length, observed: eventRoutes.filter((r) => r.behavior.observed).length },
      findings: findingStats,
      boundaries: boundaryStats,
    },
  };
}
