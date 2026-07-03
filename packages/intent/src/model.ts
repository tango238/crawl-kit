// packages/intent/src/model.ts
//
// The intent layer's input: the glossary. This is "what we MEANT to build", the
// normative model from distill-ddd. Crucially, the glossary is the ISSUER OF
// CANONICAL IDS — every other layer's nodes get reconciled onto the ids minted
// here. (STRUCTURE.md option A: emit at the source. The distill-ddd skill stays
// independent; only this contract-shaped glossary crosses the boundary.)

export type ConceptKind =
  | "aggregate-root"
  | "entity"
  | "value-object"
  | "service"
  | "policy";

export interface GlossaryConcept {
  /** canonical id, e.g. "concept:order". Derived from name when omitted. */
  id?: string;
  /** the ubiquitous-language term — the canonical name. */
  name: string;
  aliases?: string[];
  /** null when sourced from a glossary term with no aggregate role attached. */
  kind?: ConceptKind | null;
  /** owning bounded context, when known. */
  context?: string;
  /** the attributes the concept is designed to have — the strong match signal. */
  attributes: string[];
  /** other concept names this one depends on — the topology signal. */
  dependsOn?: string[];
}

/**
 * A domain event from the model. With state transitions, this is the meaningful
 * intent↔structure diff axis — coarse enough to compare mechanically, unlike
 * fine-grained domain behaviour.
 */
export interface GlossaryEvent {
  /** past-tense event name, e.g. "OrderPlaced". */
  name: string;
  /** the aggregate (concept name) that emits it. */
  aggregate?: string;
  /** owning bounded context. */
  context?: string;
  /** the command/operation that raises it. */
  trigger?: string;
  /** payload field names. */
  properties?: string[];
  /** the context/aggregate that consumes it. */
  consumer?: string;
}

/**
 * A state transition decided during the aggregates phase. `from` is "∅" for the
 * creation transition (the operation that brings the aggregate into being).
 */
export interface GlossaryStateTransition {
  /** the aggregate (concept name) whose state machine this belongs to. */
  aggregate: string;
  /** owning bounded context. */
  context?: string;
  /** source state; "∅" denotes creation from nothing. */
  from: string;
  /** target state. */
  to: string;
  /** the operation that drives the transition. */
  trigger?: string | null;
  /** the domain event the transition emits. */
  event?: string | null;
}

export interface Glossary {
  concepts: GlossaryConcept[];
  /** domain events (← domain-events.md). */
  events?: GlossaryEvent[];
  /** aggregate state transitions (← aggregates.md "状態遷移" blocks). */
  stateTransitions?: GlossaryStateTransition[];
}
