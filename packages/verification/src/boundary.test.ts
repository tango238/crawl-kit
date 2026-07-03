import { describe, expect, it } from "vitest";
import type { LayerNode } from "@crawl-kit/contract";
import { assembleBoundaries, verifyBoundary, verifyBoundaries, buildBoundaryReport, type BoundaryInput } from "./boundary.js";

const base: BoundaryInput = {
  route: "POST /orders",
  entity: "orders",
  inStructure: true,
  inBehavior: true,
  declaredInputs: ["customer_name", "total"],
  events: ["OrderPlaced"],
  persists: true,
  observedInputs: ["Customer Name", "Total"],
  saved: ["customer_name"],
};

describe("verifyBoundary", () => {
  it("passes input and reports roundtrip-ok when persisted", () => {
    const f = verifyBoundary(base);
    expect(f.find((x) => x.facet === "persistence")?.kind).toBe("roundtrip-ok");
    expect(f.some((x) => x.kind === "input-undeclared")).toBe(false); // "Customer Name" ~ customer_name
  });

  it("never emits a display facet finding (display check removed)", () => {
    const f = verifyBoundary(base);
    expect(f.some((x) => (x.facet as string) === "display")).toBe(false);
  });

  it("flags not-persisted (high) when a C/U boundary saves nothing", () => {
    const f = verifyBoundary({ ...base, saved: [] });
    const p = f.find((x) => x.facet === "persistence");
    expect(p?.kind).toBe("not-persisted");
    expect(p?.severity).toBe("high");
  });

  it("marks persistence-unobserved when saved is null (not a failure)", () => {
    const f = verifyBoundary({ ...base, saved: null });
    expect(f.find((x) => x.facet === "persistence")?.kind).toBe("persistence-unobserved");
  });

  it("flags an undeclared runtime input", () => {
    const f = verifyBoundary({ ...base, observedInputs: ["Coupon"] });
    expect(f.some((x) => x.kind === "input-undeclared")).toBe(true);
  });
});

describe("assembleBoundaries (route-keyed join of raw emits)", () => {
  const structureNodes: LayerNode[] = [
    { nodeId: "structure:route/POST /orders", layer: "structure", localName: "POST /orders", route: "POST /orders", raw: { kind: "route", entity: "orders", crud: ["C"], inputs: ["customer_name"], events: ["OrderPlaced", "StockReserved"] }, source: { tool: "rdra-analyzer" } },
  ];
  const behaviorNodes: LayerNode[] = [
    { nodeId: "behavior:page/POST /orders", layer: "behavior", localName: "POST /orders", route: "POST /orders", raw: { inputItems: [{ name: "customer_name" }], saved: ["customer_name"] }, source: { tool: "loop-e2e" } },
  ];

  it("joins route inputs, events, and behavior observation on the route key", () => {
    const [b] = assembleBoundaries(structureNodes, behaviorNodes);
    expect(b?.route).toBe("POST /orders");
    expect(b?.declaredInputs).toEqual(["customer_name"]);
    expect(b?.events).toEqual(["OrderPlaced", "StockReserved"]);
    expect(b?.persists).toBe(true);
    expect(b?.observedInputs).toEqual(["customer_name"]);
    expect(b?.saved).toEqual(["customer_name"]);
  });

  it("buildBoundaryReport tallies ok + problems and surfaces route events", () => {
    const r = buildBoundaryReport(structureNodes, behaviorNodes, "t");
    expect(r.boundaries).toBe(1);
    expect(r.findings.some((f) => f.kind === "roundtrip-ok")).toBe(true);
    expect(r.routes[0]?.events).toEqual(["OrderPlaced", "StockReserved"]);
  });
});

// --- Regression: method-aware pairing of transaction nodes + saved receptacle (spec A+B) ---
const sNode = (route: string, crud: string[]): LayerNode => ({
  nodeId: `structure:route/${route}`, layer: "structure", localName: route, route,
  raw: { inputs: ["name"], events: [], crud, entity: "Order" }, source: { tool: "rdra" },
});
const bTx = (route: string, saved?: string[]): LayerNode => ({
  nodeId: `behavior:tx/${route}`, layer: "behavior", localName: route, route,
  raw: { inputItems: ["name"], ...(saved ? { saved } : {}) }, source: { tool: "loop-e2e" },
});

describe("boundary method-aware pairing + saved", () => {
  it("pairs a POST structure route with a POST transaction node on one boundary", () => {
    const bs = assembleBoundaries([sNode("POST /orders", ["C"])], [bTx("POST /orders")]);
    expect(bs).toHaveLength(1);
    expect(bs[0]?.inStructure).toBe(true);
    expect(bs[0]?.inBehavior).toBe(true);
    expect(bs[0]?.persists).toBe(true);
  });
  it("reports roundtrip-ok when saved is present", () => {
    const rep = verifyBoundaries(assembleBoundaries([sNode("POST /orders", ["C"])], [bTx("POST /orders", ["name"])]), "t");
    expect(rep.findings.some((f) => f.kind === "roundtrip-ok")).toBe(true);
  });
  it("reports persistence-unobserved when saved is absent (A+B expected state)", () => {
    const rep = verifyBoundaries(assembleBoundaries([sNode("POST /orders", ["C"])], [bTx("POST /orders")]), "t");
    expect(rep.findings.some((f) => f.kind === "persistence-unobserved")).toBe(true);
  });
});
