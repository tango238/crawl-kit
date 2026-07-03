// packages/viewer/src/diff-assemble.ts
//
// Assemble the side-by-side DiffView entirely from the SPINE (data/*.nodes.json +
// unified + findings) — the same data the reconciler/verification produce. Shared by
// the dev server and the CLI's serve. Pure of rendering: reads inputs, returns the
// view model. Reading from the spine keeps the view in step with what was actually
// reconciled/verified — and lets `demo` populate it.
//
//   intent      ← data/intent.nodes.json     (intent:event/ , intent:transition/)
//   structure   ← data/structure.nodes.json  (structure:event/ , structure:transition/ , structure:route/→events)
//   behavior    ← data/behavior.nodes.json   (behavior:page/ → observed routes)
//   findings    ← data/verification.findings.json , data/boundary.findings.json

import { readFile } from "node:fs/promises";
import { DATA_FILES, dataPath } from "@crawl-kit/contract";
import {
  buildDiffView,
  type BehaviorAxis,
  type BoundaryFindingView,
  type BoundaryRouteView,
  type DiffView,
  type IntentAxis,
  type RouteEventLink,
  type StructureAxis,
  type VerificationFinding,
} from "./diff-view.js";

interface SpineNode {
  nodeId: string;
  localName: string;
  route?: string;
  raw?: {
    eventName?: string;
    aggregate?: string;
    context?: string;
    trigger?: string | null;
    properties?: string[];
    event?: string | null;
    from?: string | null;
    to?: string;
    provenance?: string;
    url?: string;
    events?: string[];
  };
}

async function readNodes(path: string): Promise<SpineNode[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SpineNode[];
  } catch {
    return [];
  }
}

/** intent LayerNodes → the diff's intent axis (the index). */
async function readIntentAxis(path: string): Promise<IntentAxis> {
  const nodes = await readNodes(path);
  return {
    events: nodes
      .filter((n) => n.nodeId.startsWith("intent:event/"))
      .map((n) => ({
        name: n.raw?.eventName ?? n.localName,
        aggregate: n.raw?.aggregate ?? undefined,
        context: n.raw?.context ?? undefined,
        trigger: n.raw?.trigger ?? undefined,
        properties: n.raw?.properties ?? undefined,
      })),
    stateTransitions: nodes
      .filter((n) => n.nodeId.startsWith("intent:transition/"))
      .map((n) => ({
        aggregate: n.raw?.aggregate ?? "",
        context: n.raw?.context ?? undefined,
        from: n.raw?.from ?? "",
        to: n.raw?.to ?? "",
        trigger: n.raw?.trigger ?? null,
        event: n.raw?.event ?? null,
      })),
  };
}

/** structure LayerNodes → the diff's structure axis (as-built). */
async function readStructureAxis(path: string): Promise<StructureAxis> {
  const nodes = await readNodes(path);
  return {
    events: nodes
      .filter((n) => n.nodeId.startsWith("structure:event/"))
      .map((n) => ({
        name: n.raw?.eventName ?? n.localName,
        aggregate: n.raw?.aggregate ?? undefined,
        trigger: n.raw?.trigger ?? undefined,
        source: n.raw?.provenance ?? undefined,
      })),
    stateTransitions: nodes
      .filter((n) => n.nodeId.startsWith("structure:transition/"))
      .map((n) => ({
        aggregate: n.raw?.aggregate ?? undefined,
        from: n.raw?.from ?? null,
        to: n.raw?.to ?? "",
        trigger: n.raw?.trigger ?? null,
        source: n.raw?.provenance ?? undefined,
      })),
  };
}

/** structure route→event links (from the route→event trace) for the event×route table. */
async function readRouteEvents(path: string): Promise<RouteEventLink[]> {
  const nodes = await readNodes(path);
  return nodes
    .filter((n) => n.nodeId.startsWith("structure:route/") && (n.raw?.events?.length ?? 0) > 0)
    .map((n) => ({ route: n.route ?? n.localName, events: n.raw?.events ?? [] }));
}

/** behavior LayerNodes → runtime observations (drives the "candidates" surface). */
async function readBehaviorAxis(path: string): Promise<BehaviorAxis> {
  const nodes = await readNodes(path);
  return {
    events: nodes
      .filter((n) => n.nodeId.startsWith("behavior:event/"))
      .map((n) => ({ name: n.raw?.eventName ?? n.localName, ref: n.raw?.url })),
    stateTransitions: nodes
      .filter((n) => n.nodeId.startsWith("behavior:transition/"))
      .map((n) => ({ from: n.raw?.from ?? null, to: n.raw?.to ?? "", trigger: n.raw?.trigger ?? null, ref: n.raw?.url })),
  };
}

/** route keys observed at runtime — crawled pages (and transition endpoints). */
async function readObservedRoutes(path: string): Promise<string[]> {
  const nodes = await readNodes(path);
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.nodeId.startsWith("behavior:page/")) out.add(n.route ?? n.localName);
    if (n.nodeId.startsWith("behavior:transition/")) {
      if (n.raw?.from) out.add(n.raw.from);
      if (n.raw?.to) out.add(n.raw.to);
    }
  }
  return [...out];
}

interface FindingNode {
  conceptId?: string;
  discrepancy?: { category?: string; severity?: string; expected?: string; actual?: string; location?: string };
  verdict?: { classification?: string; confidence?: number };
}

/** Read adjudicated findings from the verification report. */
async function readFindings(path: string): Promise<VerificationFinding[]> {
  let report: { findings?: FindingNode[] };
  try {
    report = JSON.parse(await readFile(path, "utf8")) as { findings?: FindingNode[] };
  } catch {
    return []; // verification not run yet
  }
  return (report.findings ?? []).map((f) => ({
    conceptId: f.conceptId ?? "",
    category: f.discrepancy?.category ?? "unknown",
    severity: (f.discrepancy?.severity as VerificationFinding["severity"]) ?? "low",
    classification: (f.verdict?.classification as VerificationFinding["classification"]) ?? "uncertain",
    expected: f.discrepancy?.expected ?? "",
    actual: f.discrepancy?.actual ?? "",
    location: f.discrepancy?.location ?? "",
    confidence: f.verdict?.confidence ?? 0,
  }));
}

/** Read the boundary report: per-facet findings + per-route observation summary. */
async function readBoundaries(path: string): Promise<{ findings: BoundaryFindingView[]; routes: BoundaryRouteView[] }> {
  try {
    const report = JSON.parse(await readFile(path, "utf8")) as {
      findings?: BoundaryFindingView[];
      routes?: BoundaryRouteView[];
    };
    return { findings: report.findings ?? [], routes: report.routes ?? [] };
  } catch {
    return { findings: [], routes: [] };
  }
}

export interface AssembleOptions {
  intentPath?: string;
  structurePath?: string;
  behaviorPath?: string;
  findingsPath?: string;
  boundaryPath?: string;
}

/** Read the spine and build the DiffView. Missing files degrade gracefully. */
export async function assembleDiff(opts: AssembleOptions = {}): Promise<DiffView> {
  const structurePath = opts.structurePath ?? dataPath(DATA_FILES.structureNodes);
  const behaviorPath = opts.behaviorPath ?? dataPath(DATA_FILES.behaviorNodes);

  const intent = await readIntentAxis(opts.intentPath ?? dataPath(DATA_FILES.intentNodes));
  const structure = await readStructureAxis(structurePath);
  const behavior = await readBehaviorAxis(behaviorPath);
  const routeEvents = await readRouteEvents(structurePath);
  const observedRoutes = await readObservedRoutes(behaviorPath);
  const findings = await readFindings(opts.findingsPath ?? dataPath(DATA_FILES.verificationFindings));
  const boundary = await readBoundaries(opts.boundaryPath ?? dataPath(DATA_FILES.boundaryFindings));

  return buildDiffView(intent, structure, behavior, {
    findings,
    boundaries: boundary.findings,
    boundaryRoutes: boundary.routes,
    routeEvents,
    observedRoutes,
  });
}
