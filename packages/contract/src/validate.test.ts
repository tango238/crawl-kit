import { describe, expect, it } from "vitest";
import type { Registry } from "./model.js";
import { ValidationError, validateRegistry } from "./validate.js";

const isoNow = "2026-06-27T00:00:00.000Z";

function baseRegistry(): Registry {
  return {
    version: 1,
    concepts: {
      "concept:order": {
        conceptId: "concept:order",
        canonicalName: "Order",
        aliases: ["orders"],
        kind: "aggregate-root",
        nodes: { structure: ["structure:table/orders"] },
        state: "aligned",
        decisions: [],
      },
    },
    adrs: {},
    relations: [],
  };
}

describe("validateRegistry", () => {
  it("accepts a referentially-sound registry", () => {
    expect(() => validateRegistry(baseRegistry())).not.toThrow();
  });

  it("rejects a concept whose map key disagrees with its conceptId", () => {
    const reg = baseRegistry();
    reg.concepts["concept:order"]!.conceptId = "concept:typo";
    expect(() => validateRegistry(reg)).toThrow(ValidationError);
  });

  it("rejects a dangling ADR reference from a concept", () => {
    const reg = baseRegistry();
    reg.concepts["concept:order"]!.decisions = ["adr:9999"];
    expect(() => validateRegistry(reg)).toThrowError(/unknown ADR "adr:9999"/);
  });

  it("rejects an ADR that affects an unknown concept", () => {
    const reg = baseRegistry();
    reg.adrs["adr:0001"] = {
      adrId: "adr:0001",
      title: "x",
      status: "accepted",
      date: isoNow,
      affects: ["concept:ghost"],
      constraints: [],
    };
    expect(() => validateRegistry(reg)).toThrowError(/affects unknown concept "concept:ghost"/);
  });

  it("rejects a relation pointing at an unknown concept", () => {
    const reg = baseRegistry();
    reg.relations = [
      {
        kind: "part-of",
        from: "structure:table/order_items",
        to: "concept:ghost",
        decidedBy: "auto",
        decidedAt: isoNow,
      },
    ];
    expect(() => validateRegistry(reg)).toThrowError(/references unknown concept "concept:ghost"/);
  });

  it("allows a relation whose endpoint is a layer-local NodeId (resolved elsewhere)", () => {
    const reg = baseRegistry();
    reg.relations = [
      {
        kind: "part-of",
        from: "structure:table/order_items",
        to: "concept:order",
        decidedBy: "auto",
        decidedAt: isoNow,
      },
    ];
    expect(() => validateRegistry(reg)).not.toThrow();
  });

  it("rejects a malformed shape (bad state enum)", () => {
    const reg = baseRegistry();
    (reg.concepts["concept:order"] as unknown as { state: string }).state = "purple";
    expect(() => validateRegistry(reg)).toThrow(ValidationError);
  });

  it("collects every issue, not just the first", () => {
    const reg = baseRegistry();
    reg.concepts["concept:order"]!.decisions = ["adr:a", "adr:b"];
    try {
      validateRegistry(reg);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues).toHaveLength(2);
    }
  });
});
