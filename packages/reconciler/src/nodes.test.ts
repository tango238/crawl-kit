import { describe, expect, it } from "vitest";
import type { LayerNode } from "@crawl-kit/contract";
import { isConceptNode } from "./nodes.js";

const node = (nodeId: string): LayerNode => ({
  nodeId,
  layer: "intent",
  localName: "x",
  raw: {},
  source: { tool: "distill-ddd" },
});

describe("isConceptNode", () => {
  it("accepts only intent:concept nodes — events/transitions are not concepts", () => {
    expect(isConceptNode(node("intent:concept/concept:order"))).toBe(true);
    expect(isConceptNode(node("intent:event/orderplaced"))).toBe(false);
    expect(isConceptNode(node("intent:transition/order/init--placed"))).toBe(false);
  });

  it("ignores non-intent layers", () => {
    expect(isConceptNode({ ...node("structure:table/orders"), layer: "structure" })).toBe(false);
  });
});
