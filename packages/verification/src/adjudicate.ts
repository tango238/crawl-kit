// packages/verification/src/adjudicate.ts
//
// The adjudication stage, merged into Verification (contexts decision: 1 BC). A panel of
// refuters (3 lenses) tries to REFUTE each finding; the Verdict is the panel outcome. This
// is the deterministic, offline panel — faithful to loop-e2e's RefuterVote/FindingVerdict
// shape. The LLM-backed refuter (services/llm/refute) migrates here later; until then the
// classification is derived from the discrepancy category so the slice is fully reproducible.

import type { Classification, Discrepancy, Lens, RefuterVote, Verdict } from "./model.js";

const LENSES: Lens[] = ["correctness", "security", "intentionality"];

/** Category → the classification a finding gets when the panel cannot refute it. */
const CATEGORY_CLASSIFICATION: Record<Discrepancy["category"], { cls: Classification; confidence: number }> = {
  "decision-violation": { cls: "bug", confidence: 0.9 },
  "runtime-error": { cls: "bug", confidence: 0.85 },
  "unverified-build": { cls: "uncertain", confidence: 0.5 },
  "undocumented-runtime": { cls: "uncertain", confidence: 0.5 },
  "unbuilt-intent": { cls: "uncertain", confidence: 0.4 },
};

/** Adjudicate a discrepancy into a Verdict via a 3-lens refuter panel (deterministic). */
export function adjudicate(discrepancy: Discrepancy): Verdict {
  const { cls, confidence } = CATEGORY_CLASSIFICATION[discrepancy.category];
  // each lens votes; a "bug" finding is NOT refuted, an "uncertain" one is partly refuted
  const votes: RefuterVote[] = LENSES.map((lens) => {
    const refuted = cls !== "bug" && lens !== "correctness";
    return {
      lens,
      refuted,
      classification: refuted ? "unnecessary" : cls,
      confidence,
      rationale: refuted
        ? `${lens}: not clearly a defect — likely accepted`
        : `${lens}: ${discrepancy.expected} ≠ ${discrepancy.actual}`,
    };
  });
  const confirmedCount = votes.filter((v) => !v.refuted).length;
  return {
    classification: confirmedCount >= 2 ? cls : "uncertain",
    confidence,
    confirmedCount,
    panelSize: votes.length,
    votes,
  };
}
