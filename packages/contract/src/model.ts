// packages/contract/src/model.ts
//
// THE SPINE.
//
// Three tools describe the same system from three different stances:
//   - intent    (distill-ddd / glossary)  — what we MEANT to build      (should-be, normative)
//   - structure (rdra-analyzer)           — what we ACTUALLY built       (as-built, static)
//   - behavior  (loop-e2e)                — what actually RUNS           (as-run, empirical)
//
// The whole suite has ONE job: tell you whether those three are the same software.
// To compare them, every tool must point at the SAME thing by the SAME name.
// This file is that shared name layer. Every layer tags its artifacts with a
// ConceptId from the registry, so "the same concept" becomes a join — not a
// guess you redo in your head every time you open a diagram.
//
// Nothing here is a "view". Views are downstream. This is the referent.

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export type Layer = "intent" | "structure" | "behavior";

/** Canonical identity of a domain concept. Issued by the glossary (intent layer). */
export type ConceptId = string; // e.g. "concept:order"
export type AdrId = string;     // e.g. "adr:0014"
/** A layer-local artifact id, namespaced by layer. e.g. "structure:table/order_items" */
export type NodeId = string;

// ---------------------------------------------------------------------------
// Concept state — this enum IS the viewer's colour legend.
// Every classification we argued through ends up as one of these.
// ---------------------------------------------------------------------------

export type ConceptState =
  | "aligned"                // present & consistent across the layers it should be in
  | "intent-only"            // designed, not yet built            (intent without structure)
  | "code-only"              // exists in code, no intent          (a leak OR a detail — see resolution)
  | "aggregate-internal"     // NOT an orphan: lives inside a matched aggregate's boundary
  | "implementation-detail"  // accepted "below the domain line"   (join tables, sessions, outbox…)
  | "adjudicated"            // a divergence EXPLAINED by an ADR    (the model is just catching up)
  | "violates-decision"      // diverges AND breaks an ADR constraint — the highest-value finding
  | "unmatched";             // not yet classified → goes to the manual reconciliation queue

// ---------------------------------------------------------------------------
// Evidence — why the reconciler thinks two things are the same.
// Deliberately NOT a single score. A human can't act on "0.82 similar".
// They can act on "same attributes, different name" vs "same name, nothing else".
// Compute the deterministic signals first; only fall to the LLM for leftovers.
// ---------------------------------------------------------------------------

export interface Evidence {
  /** glossary term vs code-derived name. Weak & noisy on the intent↔structure edge. */
  name?: { score: number; note?: string };
  /** overlap of fields/attributes. Structurally the strongest signal. */
  attributes?: { score: number; shared: string[] };
  /** does the relationship shape around the node match on both sides? */
  topology?: { score: number; note?: string };
  /** do the same operations touch it? (DDD command/event ↔ RDRA UC×entity CRUD) */
  behavior?: { score: number; note?: string };
  /** LLM judgement — fed the structural evidence above so it stays grounded. */
  llm?: { score: number; rationale: string; model: string };
}

// ---------------------------------------------------------------------------
// Layer nodes — what each tool actually emitted, before reconciliation.
// The reconciler never mutates these; it links them to concepts.
// ---------------------------------------------------------------------------

export interface LayerNode {
  nodeId: NodeId;
  layer: Layer;
  /** the name as it appears in that layer (glossary term, table name, scenario id…) */
  localName: string;
  /** free-form payload from the source tool (table cols, UC steps, finding body…) */
  raw: unknown;
  /** route/endpoint key when present — the strong key for structure↔behavior. */
  route?: string;
  /** provenance: which tool/run produced this, for traceability. */
  source: { tool: "distill-ddd" | "rdra-analyzer" | "loop-e2e"; runId?: string };
  /** behavior:tx/ mutation nodes only: the recorder's per-transaction identity (unique with
   *  runId). Present when the layer emits ONE node per recorded mutation (POST/PUT/PATCH/DELETE)
   *  so repeated same-route mutations stay individually visible. Absent for non-tx nodes and for
   *  deduped-by-route non-mutating nodes. `route` remains the structure↔behavior join key. */
  seq?: number;
  /** behavior:tx/ nodes only: was this mutation actually persisted, per the CRUD oracle?
   *  "yes"/"no" when a matching CRUD-probed step ran, "unknown" when the mutation was
   *  never probed. Absent for non-tx nodes and for tx nodes with no CRUD results this run.
   *  Route-derived: all same-route mutation nodes share one verdict (the CRUD oracle keys by
   *  route, not by browser tx — true per-tx DB probing is future work). */
  persisted?: "yes" | "no" | "unknown";
}

// ---------------------------------------------------------------------------
// Relations between concepts — NOT 1:1. A DDD aggregate is a CLUSTER of tables.
// This is also where "needed but not intended" code finds a home: it isn't an
// orphan, it's `part-of` a matched aggregate, or `serves` / `derived-from` one.
// ---------------------------------------------------------------------------

export type RelationKind =
  | "same-as"        // identity across layers (carries the Evidence)
  | "part-of"        // node belongs inside an aggregate's boundary → aggregate-internal
  | "serves"         // technical concept serving a domain one (outbox serves events)
  | "derived-from";  // read-model / projection derived from a source concept

export interface Relation {
  kind: RelationKind;
  from: ConceptId | NodeId;
  to: ConceptId | NodeId;
  evidence?: Evidence;          // present for "same-as"
  /** who decided this link held: the reconciler, or a human (burned into the registry). */
  decidedBy: "auto" | "human";
  decidedAt: string;            // ISO date
}

// ---------------------------------------------------------------------------
// ADR — the adjudicator that rides ON the edges. Not a 4th corner.
// The DDD model is a snapshot with no "why/when"; the ADR is the time + causal
// layer. Without it, "intent ≠ structure" can't tell a bug from a model that's
// merely behind a decision already made.
// Independent records (1 ADR ↔ many concepts). Start as an empty array.
// ---------------------------------------------------------------------------

export interface AdrConstraint {
  /** machine-checkable where possible, e.g. forbid a topology edge. */
  kind: "forbid-dependency" | "require-dependency" | "note";
  /** e.g. { from: "concept:payment", to: "concept:shipping" } for "Payment ↛ Shipping" */
  from?: ConceptId;
  to?: ConceptId;
  text: string;
}

export interface Adr {
  adrId: AdrId;
  title: string;
  status: "proposed" | "accepted" | "superseded" | "deprecated";
  date: string;                 // ISO
  affects: ConceptId[];         // which concepts this decision touches
  constraints: AdrConstraint[]; // checked against the structure topology
  supersedes?: AdrId;
}

// ---------------------------------------------------------------------------
// Concept — the canonical record. The registry is the set of these.
// ---------------------------------------------------------------------------

export interface Concept {
  conceptId: ConceptId;
  /** canonical name — ideally the ubiquitous-language term from the glossary. */
  canonicalName: string;
  aliases: string[];
  kind?: "aggregate-root" | "entity" | "value-object" | "service" | "policy";
  /** which layers this concept is REPRESENTED in (links resolve to LayerNodes). */
  nodes: Partial<Record<Layer, NodeId[]>>;
  /** the classification that drives the colour. Computed by the reconciler. */
  state: ConceptState;
  /** ADRs that touch this concept (the multi-to-many back-reference). Empty is fine. */
  decisions: AdrId[];
  /** if state was a human call, the note is kept so the next run doesn't re-ask. */
  resolution?: { decidedBy: "auto" | "human"; note?: string; decidedAt: string };
}

// ---------------------------------------------------------------------------
// The two files the reconciler owns.
//   registry.json — DURABLE. The spine + every human decision ever made.
//   unified.json  — DERIVED. What the viewer eats. Throwaway/rebuildable.
// Keeping the registry out of browser state is the whole point: it's what lets
// all three tools read the same IDs and tag their own output. (This is what
// replaces loop-e2e's point-to-point `rdra-export` stitching.)
// ---------------------------------------------------------------------------

export interface Registry {
  version: 1;
  concepts: Record<ConceptId, Concept>;
  adrs: Record<AdrId, Adr>;
  relations: Relation[];
}

/** A single concept resolved across all three layers — one row of the diff view. */
export interface UnifiedConcept {
  conceptId: ConceptId;
  canonicalName: string;
  state: ConceptState;
  intent?: LayerNode;
  structure?: LayerNode[];   // plural: an aggregate maps to many tables
  behavior?: LayerNode[];    // plural: many findings/scenarios can touch it
  decisions: Adr[];
  /** the specific edge(s) that diverge, ready to render red. */
  divergences: Array<{
    edge: "intent↔structure" | "structure↔behavior" | "intent↔behavior";
    detail: string;
    adjudicatedBy?: AdrId;     // present when an ADR explains/forgives it
    violates?: AdrId;          // present when it breaks a constraint
  }>;
}

export interface Unified {
  version: 1;
  generatedAt: string;
  concepts: UnifiedConcept[];
}
