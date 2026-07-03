// packages/verification/src/model.ts
//
// The Verification (検証＋裁定) context — the Core, positioned AFTER reconciliation.
// Unlike loop-e2e's baseline-diff (which verifies against structure alone), this verifies
// against the RECONCILED three-layer model (unified.json): intent↔structure↔behavior joined
// on the canonical registry. That join is what unlocks the richer checks here.
//
// Aggregate (aggregates.md): a Finding is the atomic unit — a Discrepancy with its Verdict
// folded in (verification + adjudication are one context). The Verdict is derived from the
// refuter votes (immediate consistency).

/** crawl-kit's reconciliation-aware finding categories (distinct from loop-e2e's runtime ones). */
export type FindingCategory =
  | "decision-violation"   // an ADR constraint is broken (violates-decision)
  | "unverified-build"     // built (structure) but never observed running (code-only)
  | "unbuilt-intent"       // designed (intent) but not built (intent-only)
  | "undocumented-runtime" // observed running but absent from structure/intent (unmatched)
  | "runtime-error";       // a behavior observation reported an error on a matched concept

export type Severity = "high" | "medium" | "low";
export type Classification = "bug" | "unnecessary" | "uncertain";
export type Lens = "correctness" | "security" | "intentionality";

/** What was expected vs what was found — the discrepancy at the heart of a Finding. */
export interface Discrepancy {
  category: FindingCategory;
  severity: Severity;
  expected: string;
  actual: string;
  evidence: string;
  /** the concept/route this discrepancy is located at. */
  location: string;
}

/** One refuter's vote (← loop-e2e RefuterVote). The panel tries to REFUTE the finding. */
export interface RefuterVote {
  lens: Lens;
  refuted: boolean;
  classification: Classification;
  confidence: number;
  rationale: string;
}

/** The adjudication outcome, derived from the votes (immediate consistency within Finding). */
export interface Verdict {
  classification: Classification;
  confidence: number;
  confirmedCount: number;
  panelSize: number;
  votes: RefuterVote[];
}

/** The atomic verification unit: a discrepancy with its verdict. */
export interface Finding {
  id: string;
  /** identity for known-state burn-in (de-dup across runs). */
  fingerprint: string;
  /** the canonical concept this finding came from. */
  conceptId: string;
  discrepancy: Discrepancy;
  verdict: Verdict;
}

export interface VerificationReport {
  generatedAt: string;
  unifiedRef: string;
  findings: Finding[];
  summary: {
    total: number;
    bug: number;
    uncertain: number;
    unnecessary: number;
  };
}
