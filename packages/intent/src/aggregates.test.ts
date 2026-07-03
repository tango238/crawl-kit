import { describe, expect, it } from "vitest";
import { deriveAggregates } from "./aggregates.js";
import type { Glossary } from "./model.js";

describe("deriveAggregates", () => {
  it("splits members between two aggregate roots via dependsOn", () => {
    const glossary: Glossary = {
      concepts: [
        { name: "Order", kind: "aggregate-root", attributes: [] },
        { name: "Customer", kind: "aggregate-root", attributes: [] },
        { name: "OrderLine", kind: "entity", attributes: [], dependsOn: ["Order"] },
        { name: "Address", kind: "entity", attributes: [], dependsOn: ["Customer"] },
      ],
    };

    const doc = deriveAggregates(glossary);

    expect(doc.aggregates).toHaveLength(2);

    const order = doc.aggregates.find((a) => a.name === "Order");
    expect(order?.conceptId).toBe("concept:order");
    expect(order?.members).toEqual([
      { conceptId: "concept:order", name: "Order", via: "self" },
      { conceptId: "concept:orderline", name: "OrderLine", via: "dependsOn" },
    ]);

    const customer = doc.aggregates.find((a) => a.name === "Customer");
    expect(customer?.conceptId).toBe("concept:customer");
    expect(customer?.members).toEqual([
      { conceptId: "concept:customer", name: "Customer", via: "self" },
      { conceptId: "concept:address", name: "Address", via: "dependsOn" },
    ]);
  });

  it("excludes kind-less concepts from the aggregate roster", () => {
    const glossary: Glossary = {
      concepts: [
        { name: "Order", kind: "aggregate-root", attributes: [] },
        { name: "Note", attributes: [] },
      ],
    };

    const doc = deriveAggregates(glossary);

    expect(doc.aggregates).toHaveLength(1);
    expect(doc.aggregates[0]?.name).toBe("Order");
  });

  it("ignores dependsOn entries that reference no known concept", () => {
    const glossary: Glossary = {
      concepts: [
        { name: "Order", kind: "aggregate-root", attributes: [] },
        { name: "Ghost", kind: "entity", attributes: [], dependsOn: ["Nonexistent"] },
      ],
    };

    const doc = deriveAggregates(glossary);

    expect(doc.aggregates).toHaveLength(1);
    expect(doc.aggregates[0]?.members).toEqual([
      { conceptId: "concept:order", name: "Order", via: "self" },
    ]);
  });
});
