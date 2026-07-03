import { describe, expect, it } from "vitest";
import { buildDiffView, type IntentAxis, type StructureAxis } from "./diff-view.js";

const intent: IntentAxis = {
  events: [
    { name: "OrderPlaced", aggregate: "Order", trigger: "place()" },
    { name: "OrderShipped", aggregate: "Order", trigger: "ship()" },
  ],
  stateTransitions: [
    { aggregate: "Order", from: "∅", to: "Placed", trigger: "place()" },
    { aggregate: "Order", from: "Placed", to: "Shipped", trigger: "ship()" },
  ],
};

const structure: StructureAxis = {
  events: [
    { name: "OrderPlaced", source: "src/order.ts:3" },
    { name: "RefundIssued", source: "src/refund.ts:9" }, // not in intent → candidate
  ],
  stateTransitions: [
    { aggregate: "Order", from: null, to: "placed", source: "src/order.ts:5" },
    { aggregate: "Order", from: null, to: "cancelled", source: "src/order.ts:8" }, // candidate
  ],
};

describe("buildDiffView", () => {
  const view = buildDiffView(intent, structure);

  it("indexes on intent: one row per intent event, matched by name", () => {
    expect(view.events.map((r) => [r.label, r.status])).toEqual([
      ["OrderPlaced", "aligned"],
      ["OrderShipped", "gap"], // no code event
    ]);
    expect(view.events[0]?.structure.ref).toBe("src/order.ts:3");
  });

  it("event/transition rows carry no behavior cell (behavior lives in the event×route table)", () => {
    expect(view.events.every((r) => !("behavior" in r))).toBe(true);
    expect(view.transitions.every((r) => !("behavior" in r))).toBe(true);
  });

  it("matches transitions by target state (structure rarely knows `from`)", () => {
    expect(view.transitions.map((r) => [r.label, r.status])).toEqual([
      ["∅ → Placed", "aligned"], // matched on 'placed'
      ["Placed → Shipped", "gap"],
    ]);
  });

  it("surfaces code-only items as candidates, not defects", () => {
    expect(view.candidates.events.map((c) => c.label)).toEqual(["RefundIssued"]);
    expect(view.candidates.transitions.map((c) => c.label)).toEqual(["Order: ? → cancelled"]);
  });

  it("lists unmatched runtime observations as behavior candidates", () => {
    const v = buildDiffView(intent, {}, {
      stateTransitions: [{ from: "/orders", to: "/orders/new", trigger: "click New" }],
    });
    expect(v.candidates.transitions).toContainEqual(
      expect.objectContaining({ layer: "behavior", label: "/orders → /orders/new" }),
    );
  });

  it("tallies stats", () => {
    expect(view.stats.events).toEqual({ total: 2, aligned: 1, gap: 1 });
    expect(view.stats.transitions).toEqual({ total: 2, aligned: 1, gap: 1 });
    expect(view.stats.candidates).toBe(2);
  });

  it("empty intent → empty view, no crash", () => {
    expect(buildDiffView({}, {}).stats.events.total).toBe(0);
  });
});

describe("buildDiffView — event×route table (verification view)", () => {
  it("lists events with their routes and intent/structure presence; behavior via route reverse-lookup", () => {
    const view = buildDiffView(intent, structure, {}, {
      routeEvents: [{ route: "POST /orders", events: ["OrderPlaced"] }],
      observedRoutes: ["GET /orders"], // path /orders observed → infers OrderPlaced's route ran
    });
    const placed = view.eventRoutes.find((r) => r.event === "OrderPlaced");
    expect(placed).toMatchObject({
      event: "OrderPlaced",
      route: "POST /orders",
      intent: true,
      structure: true,
      behavior: { observed: true, via: "route" },
    });
  });

  it("an event with no emitting route gets one row with no route and behavior not observed", () => {
    const view = buildDiffView(intent, {}, {}, {});
    const shipped = view.eventRoutes.find((r) => r.event === "OrderShipped");
    expect(shipped).toMatchObject({ event: "OrderShipped", intent: true, structure: false, behavior: { observed: false } });
    expect(shipped?.route).toBeUndefined();
  });

  it("emits one row per (event × route) when an event has several routes", () => {
    const view = buildDiffView(intent, structure, {}, {
      routeEvents: [
        { route: "POST /orders", events: ["OrderPlaced"] },
        { route: "PUT /orders/:id", events: ["OrderPlaced"] },
      ],
      observedRoutes: [],
    });
    const placedRows = view.eventRoutes.filter((r) => r.event === "OrderPlaced");
    expect(placedRows.map((r) => r.route)).toEqual(["POST /orders", "PUT /orders/:id"]);
    expect(placedRows.every((r) => r.behavior.observed === false)).toBe(true);
  });

  it("behavior stays not-observed when the emitting route's path was never crawled", () => {
    const view = buildDiffView(intent, structure, {}, {
      routeEvents: [{ route: "POST /orders", events: ["OrderPlaced"] }],
      observedRoutes: ["GET /unrelated"],
    });
    expect(view.eventRoutes.find((r) => r.event === "OrderPlaced")?.behavior.observed).toBe(false);
  });

  it("includes structure-only events (not in intent) in the table", () => {
    const view = buildDiffView(intent, structure, {}, {});
    const refund = view.eventRoutes.find((r) => r.event === "RefundIssued");
    expect(refund).toMatchObject({ intent: false, structure: true });
  });

  it("tallies observed event-routes", () => {
    const view = buildDiffView(intent, structure, {}, {
      routeEvents: [{ route: "POST /orders", events: ["OrderPlaced"] }],
      observedRoutes: ["GET /orders"],
    });
    expect(view.stats.eventRoutes.observed).toBe(1);
  });
});

describe("buildDiffView — event DiffRow.routes pre-join (server-side event→route join)", () => {
  it("attaches the event's emitting EventRouteRows to its event DiffRow with correct behavior.observed", () => {
    const view = buildDiffView(intent, structure, {}, {
      routeEvents: [
        { route: "POST /orders", events: ["OrderPlaced"] },
        { route: "PUT /orders/:id", events: ["OrderPlaced"] },
      ],
      observedRoutes: ["GET /orders"], // path /orders observed → POST /orders' event inferred observed
    });
    const placed = view.events.find((r) => r.label === "OrderPlaced");
    expect(placed?.routes).toBeDefined();
    expect(placed?.routes?.map((r) => r.route)).toEqual(["POST /orders", "PUT /orders/:id"]);
    expect(placed?.routes?.map((r) => r.behavior.observed)).toEqual([true, false]);
    // rows carry the full EventRouteRow shape (event/intent/structure preserved)
    expect(placed?.routes?.[0]).toMatchObject({ event: "OrderPlaced", intent: true, structure: true });
  });

  it("event with no emitting route gets an empty routes array", () => {
    const view = buildDiffView(intent, structure, {}, {});
    const placed = view.events.find((r) => r.label === "OrderPlaced");
    expect(placed?.routes).toEqual([]);
  });

  it("keeps the top-level eventRoutes array intact alongside the per-row routes", () => {
    const view = buildDiffView(intent, structure, {}, {
      routeEvents: [{ route: "POST /orders", events: ["OrderPlaced"] }],
      observedRoutes: [],
    });
    expect(view.eventRoutes.some((r) => r.event === "OrderPlaced" && r.route === "POST /orders")).toBe(true);
  });
});

describe("buildDiffView — verification findings", () => {
  const findings = [
    { conceptId: "concept:order", category: "unbuilt-intent", severity: "low" as const, classification: "uncertain" as const, expected: "built", actual: "missing", location: "Order", confidence: 0.4 },
    { conceptId: "concept:payment", category: "decision-violation", severity: "high" as const, classification: "bug" as const, expected: "no dep", actual: "depends", location: "Payment", confidence: 0.9 },
  ];

  it("orders findings worst-first (bug+high before uncertain+low) and tallies", () => {
    const view = buildDiffView(intent, {}, {}, { findings });
    expect(view.findings.map((f) => f.classification)).toEqual(["bug", "uncertain"]);
    expect(view.stats.findings).toEqual({ total: 2, bug: 1, uncertain: 1, unnecessary: 0 });
  });

  it("defaults to empty findings", () => {
    expect(buildDiffView(intent, {}).stats.findings.total).toBe(0);
  });
});

describe("buildDiffView — boundary findings", () => {
  const boundaries = [
    { route: "POST /orders", facet: "persistence" as const, kind: "roundtrip-ok", severity: "low" as const, ok: true, detail: "保存確認" },
    { route: "POST /orders", facet: "persistence" as const, kind: "not-persisted", severity: "high" as const, ok: false, detail: "残らない" },
    { route: "GET /x", facet: "input" as const, kind: "input-undeclared", severity: "medium" as const, ok: false, detail: "未宣言入力" },
  ];

  it("orders problems first (high → low), ok last, and tallies", () => {
    const view = buildDiffView(intent, {}, {}, { boundaries });
    expect(view.boundaries.map((b) => b.kind)).toEqual(["not-persisted", "input-undeclared", "roundtrip-ok"]);
    expect(view.stats.boundaries).toEqual({ total: 3, problems: 2, high: 1, ok: 1 });
  });

  it("passes through per-route events on boundaryRoutes", () => {
    const view = buildDiffView(intent, {}, {}, {
      boundaryRoutes: [{ route: "POST /orders", entity: "orders", structure: true, behavior: false, events: ["OrderPlaced"], problems: 0, ok: 1 }],
    });
    expect(view.boundaryRoutes[0]?.events).toEqual(["OrderPlaced"]);
  });

  it("defaults to empty", () => {
    expect(buildDiffView(intent, {}).stats.boundaries.total).toBe(0);
  });
});
