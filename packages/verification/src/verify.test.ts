import { describe, expect, it } from "vitest";
import type { Unified, UnifiedConcept } from "@crawl-kit/contract";
import { verifyUnified, buildReport } from "./verify.js";
import { adjudicate } from "./adjudicate.js";

function concept(partial: Partial<UnifiedConcept> & { conceptId: string; state: UnifiedConcept["state"] }): UnifiedConcept {
  return { canonicalName: partial.conceptId, decisions: [], divergences: [], ...partial };
}

function unified(concepts: UnifiedConcept[]): Unified {
  return { version: 1, generatedAt: "2026-06-27T00:00:00.000Z", concepts };
}

describe("verifyUnified — reconciliation-aware checks", () => {
  it("turns a violates-decision concept into a high-severity bug finding", () => {
    const u = unified([
      concept({
        conceptId: "concept:payment",
        canonicalName: "Payment",
        state: "violates-decision",
        divergences: [{ edge: "intent↔structure", detail: "Payment ↛ Shipping", violates: "adr:0010" }],
      }),
    ]);
    const [f] = verifyUnified(u);
    expect(f?.discrepancy.category).toBe("decision-violation");
    expect(f?.discrepancy.severity).toBe("high");
    expect(f?.verdict.classification).toBe("bug");
    expect(f?.discrepancy.evidence).toBe("adr:0010");
  });

  it("maps the four problem states to finding categories", () => {
    const u = unified([
      concept({ conceptId: "concept:struct/ab_tests", canonicalName: "ab_tests", state: "code-only" }),
      concept({ conceptId: "concept:refund", canonicalName: "Refund", state: "intent-only" }),
      concept({ conceptId: "concept:route/GET /health", canonicalName: "GET /health", state: "unmatched" }),
    ]);
    const cats = verifyUnified(u).map((f) => f.discrepancy.category).sort();
    expect(cats).toEqual(["unbuilt-intent", "undocumented-runtime", "unverified-build"]);
  });

  it("does NOT flag legitimate states (aligned / aggregate-internal / implementation-detail)", () => {
    const u = unified([
      concept({ conceptId: "a", state: "aligned" }),
      concept({ conceptId: "b", state: "aggregate-internal" }),
      concept({ conceptId: "c", state: "implementation-detail" }),
      concept({ conceptId: "d", state: "adjudicated" }),
    ]);
    expect(verifyUnified(u)).toHaveLength(0);
  });

  it("flags a runtime error observed on an otherwise-aligned concept", () => {
    const u = unified([
      concept({
        conceptId: "concept:order",
        canonicalName: "Order",
        state: "aligned",
        behavior: [
          {
            nodeId: "behavior:route/GET /orders/777",
            layer: "behavior",
            localName: "GET /orders/777",
            raw: { findings: [{ severity: "error", note: "5xx", status: 500 }] },
            source: { tool: "loop-e2e" },
          },
        ],
      }),
    ]);
    const [f] = verifyUnified(u);
    expect(f?.discrepancy.category).toBe("runtime-error");
    expect(f?.verdict.classification).toBe("bug");
  });
});

describe("adjudicate — refuter panel", () => {
  it("confirms a violation (panel cannot refute) → bug", () => {
    const v = adjudicate({ category: "decision-violation", severity: "high", expected: "x", actual: "y", evidence: "", location: "P" });
    expect(v.classification).toBe("bug");
    expect(v.confirmedCount).toBe(v.panelSize);
    expect(v.votes).toHaveLength(3);
  });

  it("an uncertain finding is partly refuted → uncertain", () => {
    const v = adjudicate({ category: "unverified-build", severity: "medium", expected: "x", actual: "y", evidence: "", location: "Q" });
    expect(v.classification).toBe("uncertain");
    expect(v.confirmedCount).toBeLessThan(v.panelSize);
  });
});

describe("buildReport", () => {
  it("summarizes findings by classification", () => {
    const u = unified([
      concept({ conceptId: "concept:payment", state: "violates-decision", divergences: [{ edge: "intent↔structure", detail: "x", violates: "adr:1" }] }),
      concept({ conceptId: "concept:refund", state: "intent-only" }),
    ]);
    const r = buildReport(u, "2026-06-27T00:00:00.000Z");
    expect(r.summary.total).toBe(2);
    expect(r.summary.bug).toBe(1);
    expect(r.summary.uncertain).toBe(1);
  });
});
