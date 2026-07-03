// packages/verification/src/verify.ts
//
// Verify the RECONCILED model (unified.json) and produce adjudicated Findings. This is the
// payoff of positioning verification AFTER reconciliation: the checks here read the joined
// three-layer state (which loop-e2e's baseline-diff could not see) and turn the
// reconciliation-aware discrepancies into Findings carrying a Verdict.

import type { Unified, UnifiedConcept } from "@crawl-kit/contract";
import { adjudicate } from "./adjudicate.js";
import type { Discrepancy, Finding, VerificationReport } from "./model.js";

function fingerprint(category: string, location: string): string {
  return `${category}:${location.toLowerCase().replace(/\s+/g, "-")}`;
}

/** Behavior findings of error severity attached to a concept (a runtime failure observed). */
function behaviorErrors(concept: UnifiedConcept): string[] {
  const out: string[] = [];
  for (const node of concept.behavior ?? []) {
    const findings = (node.raw as { findings?: Array<{ severity?: string; note?: string; status?: number }> })?.findings ?? [];
    for (const f of findings) {
      if (f.severity === "error") out.push(`${node.localName}: ${f.note ?? ""} (${f.status ?? "?"})`);
    }
  }
  return out;
}

/** The reconciliation-aware discrepancy (if any) for one concept's state. */
function discrepancyFor(concept: UnifiedConcept): Discrepancy | null {
  const loc = concept.canonicalName;
  switch (concept.state) {
    case "violates-decision": {
      const d = concept.divergences.find((x) => x.violates);
      return {
        category: "decision-violation",
        severity: "high",
        expected: "ADR の制約が守られている",
        actual: d?.detail ?? "decision violated",
        evidence: d?.violates ?? "",
        location: loc,
      };
    }
    case "code-only":
      return {
        category: "unverified-build",
        severity: "medium",
        expected: "実装が実行時に観測される",
        actual: "structure に在るが behavior 未観測",
        evidence: loc,
        location: loc,
      };
    case "intent-only":
      return {
        category: "unbuilt-intent",
        severity: "low",
        expected: "設計が実装されている",
        actual: "intent に在るが structure/behavior 無し",
        evidence: loc,
        location: loc,
      };
    case "unmatched":
      return {
        category: "undocumented-runtime",
        severity: "medium",
        expected: "実行時の振る舞いが設計に対応する",
        actual: "behavior に在るが structure/intent に無い",
        evidence: loc,
        location: loc,
      };
    default:
      return null; // aligned / aggregate-internal / implementation-detail / adjudicated は正当
  }
}

/** Produce adjudicated Findings from the reconciled model. */
export function verifyUnified(unified: Unified): Finding[] {
  const findings: Finding[] = [];
  let seq = 0;
  const push = (conceptId: string, d: Discrepancy) => {
    findings.push({
      id: `VF-${String(++seq).padStart(3, "0")}`,
      fingerprint: fingerprint(d.category, d.location),
      conceptId,
      discrepancy: d,
      verdict: adjudicate(d),
    });
  };

  for (const concept of unified.concepts) {
    const d = discrepancyFor(concept);
    if (d) push(concept.conceptId, d);

    // runtime errors are worth a finding even on an otherwise-aligned concept
    for (const err of behaviorErrors(concept)) {
      push(concept.conceptId, {
        category: "runtime-error",
        severity: "high",
        expected: "実行時にエラーが起きない",
        actual: err,
        evidence: err,
        location: concept.canonicalName,
      });
    }
  }
  return findings;
}

export function buildReport(unified: Unified, now: string): VerificationReport {
  const findings = verifyUnified(unified);
  const by = (c: string) => findings.filter((f) => f.verdict.classification === c).length;
  return {
    generatedAt: now,
    unifiedRef: unified.generatedAt,
    findings,
    summary: { total: findings.length, bug: by("bug"), uncertain: by("uncertain"), unnecessary: by("unnecessary") },
  };
}
