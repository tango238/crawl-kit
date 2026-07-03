import { describe, expect, it } from "vitest";
import {
  canonicalId,
  emitEventNodes,
  emitIntentNodes,
  emitStateTransitionNodes,
  slugify,
} from "./emit.js";
import type { Glossary } from "./model.js";

describe("canonicalId", () => {
  it("mints concept:<slug> from a name", () => {
    expect(canonicalId({ name: "Order", attributes: [] })).toBe("concept:order");
    expect(canonicalId({ name: "Loyalty Tier", attributes: [] })).toBe("concept:loyalty-tier");
  });
  it("honours an explicit id", () => {
    expect(canonicalId({ id: "concept:o", name: "Order", attributes: [] })).toBe("concept:o");
  });
});

describe("emitIntentNodes", () => {
  const glossary: Glossary = {
    concepts: [
      { name: "Order", kind: "aggregate-root", attributes: ["id", "total"], dependsOn: ["Customer"] },
    ],
  };
  it("emits intent nodes carrying the canonical id and attributes", () => {
    const [node] = emitIntentNodes(glossary);
    expect(node?.layer).toBe("intent");
    expect(node?.source.tool).toBe("distill-ddd");
    const raw = node?.raw as { conceptId: string; attributes: string[]; dependsOn: string[] };
    expect(raw.conceptId).toBe("concept:order");
    expect(raw.attributes).toEqual(["id", "total"]);
    expect(raw.dependsOn).toEqual(["Customer"]);
  });
});

describe("emitEventNodes", () => {
  const glossary: Glossary = {
    concepts: [],
    events: [
      {
        name: "OrderPlaced",
        aggregate: "Order",
        context: "Sales",
        trigger: "place()",
        properties: ["orderId", "occurredOn"],
        consumer: "Shipping",
      },
    ],
  };
  it("emits one intent:event node per event, linked to its aggregate concept", () => {
    const [node] = emitEventNodes(glossary, "run-1");
    expect(node?.nodeId).toBe("intent:event/orderplaced");
    expect(node?.layer).toBe("intent");
    expect(node?.localName).toBe("OrderPlaced");
    expect(node?.source.runId).toBe("run-1");
    const raw = node?.raw as { aggregateConceptId: string; properties: string[]; trigger: string };
    expect(raw.aggregateConceptId).toBe("concept:order");
    expect(raw.properties).toEqual(["orderId", "occurredOn"]);
    expect(raw.trigger).toBe("place()");
  });
  it("returns nothing when there are no events", () => {
    expect(emitEventNodes({ concepts: [] })).toEqual([]);
  });
});

describe("emitStateTransitionNodes", () => {
  const glossary: Glossary = {
    concepts: [],
    stateTransitions: [
      { aggregate: "Order", context: "Sales", from: "∅", to: "Placed", trigger: "place()", event: "OrderPlaced" },
      { aggregate: "Order", from: "Placed", to: "Shipped", trigger: "ship()", event: "OrderShipped" },
    ],
  };
  it("encodes the creation transition (∅) with an 'init' slug", () => {
    const [creation] = emitStateTransitionNodes(glossary);
    expect(creation?.nodeId).toBe("intent:transition/order/init--placed");
    expect(creation?.localName).toBe("Order: ∅ → Placed");
    const raw = creation?.raw as { from: string; to: string; aggregateConceptId: string; event: string };
    expect(raw.from).toBe("∅");
    expect(raw.aggregateConceptId).toBe("concept:order");
    expect(raw.event).toBe("OrderPlaced");
  });
  it("encodes a state→state transition", () => {
    const node = emitStateTransitionNodes(glossary)[1];
    expect(node?.nodeId).toBe("intent:transition/order/placed--shipped");
    expect((node?.raw as { trigger: string }).trigger).toBe("ship()");
  });
});

describe("emitIntentNodes (all axes)", () => {
  it("emits concepts, then events, then transitions", () => {
    const glossary: Glossary = {
      concepts: [{ name: "Order", attributes: [] }],
      events: [{ name: "OrderPlaced", aggregate: "Order" }],
      stateTransitions: [{ aggregate: "Order", from: "∅", to: "Placed" }],
    };
    const ids = emitIntentNodes(glossary).map((n) => n.nodeId);
    expect(ids).toEqual([
      "intent:concept/concept:order",
      "intent:event/orderplaced",
      "intent:transition/order/init--placed",
    ]);
  });
});

describe("slugify", () => {
  it("kebab-cases ascii and empties out a non-ascii state like ∅", () => {
    expect(slugify("Loyalty Tier")).toBe("loyalty-tier");
    expect(slugify("∅")).toBe("");
  });
});
