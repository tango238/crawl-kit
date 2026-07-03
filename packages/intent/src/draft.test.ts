import { describe, expect, it, vi } from "vitest";
import { draftGlossary } from "./draft.js";
import type { DraftInput, DraftLlm } from "./draft.js";

const input: DraftInput = {
  repoNotes: [{ name: "shop-api", framework: "rails", structureSummary: "orders + customers" }],
  entityNames: ["Order", "Customer"],
  routeSummaries: ["POST /orders"],
};

const VALID_JSON = JSON.stringify({
  concepts: [
    { name: "Order", kind: "aggregate-root", attributes: ["orderId", "status"] },
    { name: "Customer", kind: "aggregate-root", attributes: ["customerId"] },
  ],
  events: [{ name: "OrderPlaced", aggregate: "Order" }],
  stateTransitions: [{ aggregate: "Order", from: "∅", to: "Placed" }],
});

describe("draftGlossary", () => {
  it("returns a Glossary when the LLM returns valid JSON on the first try", async () => {
    const llm: DraftLlm = { completeSimple: vi.fn(async () => VALID_JSON) };

    const glossary = await draftGlossary(input, llm);

    expect(glossary.concepts).toHaveLength(2);
    expect(glossary.concepts[0]).toEqual({
      name: "Order",
      kind: "aggregate-root",
      attributes: ["orderId", "status"],
    });
    expect(glossary.events?.[0]?.name).toBe("OrderPlaced");
    expect(glossary.stateTransitions?.[0]).toEqual({ aggregate: "Order", from: "∅", to: "Placed" });
    expect(llm.completeSimple).toHaveBeenCalledTimes(1);
  });

  it("retries once and succeeds when the first response is invalid", async () => {
    const completeSimple = vi
      .fn<DraftLlm["completeSimple"]>()
      .mockResolvedValueOnce("this is not json at all")
      .mockResolvedValueOnce(VALID_JSON);
    const llm: DraftLlm = { completeSimple };

    const glossary = await draftGlossary(input, llm);

    expect(glossary.concepts).toHaveLength(2);
    expect(completeSimple).toHaveBeenCalledTimes(2);
    // the retry message carries the corrective instruction AND preserves original domain context
    const secondCallArgs = completeSimple.mock.calls[1];
    const retryMessage = secondCallArgs?.[0];
    expect(retryMessage).toContain("前回の応答は不正なJSONだった。JSONのみを返せ");
    expect(retryMessage).toContain("shop-api"); // repo name from input
  });

  it("throws when both attempts return invalid responses", async () => {
    const completeSimple = vi
      .fn<DraftLlm["completeSimple"]>()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce("still not json");
    const llm: DraftLlm = { completeSimple };

    await expect(draftGlossary(input, llm)).rejects.toThrow();
    expect(completeSimple).toHaveBeenCalledTimes(2);
  });

  it("extracts JSON embedded in surrounding prose", async () => {
    const prosed = `承知しました。以下がドラフトです。\n\n\`\`\`json\n${VALID_JSON}\n\`\`\`\n\n以上です。`;
    const llm: DraftLlm = { completeSimple: vi.fn(async () => prosed) };

    const glossary = await draftGlossary(input, llm);

    expect(glossary.concepts).toHaveLength(2);
    expect(glossary.concepts.map((c) => c.name)).toEqual(["Order", "Customer"]);
  });
});
