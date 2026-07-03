import { describe, expect, it } from "vitest";
import { emitStructureNodes } from "./emit.js";
import type { StructureExtract } from "./model.js";

const extract: StructureExtract = {
  routes: [
    { method: "get", path: "/orders/:id", handler: "getOrder" },
    { method: "POST", path: "/orders", handler: "createOrder" },
  ],
  entities: [
    { name: "orders", attributes: ["id", "customer_id", "total"], dependsOn: ["customers"] },
    { name: "customers", attributes: ["id", "name", "email"] },
  ],
  usecases: [
    { name: "GetOrder", entity: "orders", route: { method: "GET", path: "/orders/:id" }, crud: ["R"] },
    { name: "CreateOrder", entity: "orders", route: { method: "POST", path: "/orders" }, crud: ["C"] },
  ],
};

describe("emitStructureNodes", () => {
  it("emits both route and entity nodes", () => {
    const nodes = emitStructureNodes(extract);
    const routes = nodes.filter((n) => (n.raw as { kind: string }).kind === "route");
    const entities = nodes.filter((n) => (n.raw as { kind: string }).kind === "entity");
    expect(routes).toHaveLength(2);
    expect(entities).toHaveLength(2);
  });

  it("anchors a route node to its entity via the usecase map", () => {
    const nodes = emitStructureNodes(extract);
    const getOrder = nodes.find((n) => n.route === "GET /orders/:id");
    expect((getOrder?.raw as { entity?: string }).entity).toBe("orders");
  });

  it("entity nodes carry attributes and topology for the intent↔structure edge", () => {
    const nodes = emitStructureNodes(extract);
    const orders = nodes.find((n) => n.nodeId === "structure:entity/orders");
    const raw = orders?.raw as { attributes: string[]; dependsOn: string[] };
    expect(raw.attributes).toContain("customer_id");
    expect(raw.dependsOn).toEqual(["customers"]);
  });

  it("upper-cases the route method in the key", () => {
    const nodes = emitStructureNodes(extract);
    expect(nodes.find((n) => n.route === "GET /orders/:id")).toBeTruthy();
  });

  it("emits event and transition nodes mirroring the intent conventions", () => {
    const withAxis: StructureExtract = {
      ...extract,
      events: [{ name: "OrderPlaced", aggregate: "Order", source: "src/order.ts:3" }],
      stateTransitions: [{ aggregate: "Order", from: null, to: "shipped", trigger: "ship", source: "src/order.ts:5" }],
    };
    const nodes = emitStructureNodes(withAxis, "run-1");

    const event = nodes.find((n) => n.nodeId === "structure:event/orderplaced");
    expect(event?.layer).toBe("structure");
    expect((event?.raw as { aggregateConceptId: string }).aggregateConceptId).toBe("concept:order");
    expect((event?.raw as { provenance: string }).provenance).toBe("src/order.ts:3");

    const transition = nodes.find((n) => n.nodeId === "structure:transition/order/any--shipped");
    expect(transition).toBeTruthy();
    expect((transition?.raw as { from: string | null }).from).toBeNull();
    expect((transition?.raw as { to: string }).to).toBe("shipped");
  });

  it("omits event/transition nodes when the extract has none", () => {
    const nodes = emitStructureNodes(extract);
    expect(nodes.some((n) => n.nodeId.startsWith("structure:event/"))).toBe(false);
    expect(nodes.some((n) => n.nodeId.startsWith("structure:transition/"))).toBe(false);
  });
});
