// packages/structure/src/model.ts
//
// The structure layer's internal model — "what we actually built", read statically.
// This is the TS realization of rdra-analyzer's static extraction core. The original
// Python parser is LLM-driven over real source; here the parse RESULT is the input
// (a StructureExtract), so the deterministic downstream — information model, CRUD
// gap, diagrams, and the route/entity emit — is exercised end-to-end without an LLM.
// (Wiring the live source parser back in is a drop-in at `analyze/`; the shapes hold.)

export type Crud = "C" | "R" | "U" | "D";

/** An endpoint the source statically declares — params already templated. */
export interface RouteRecord {
  method: string;
  path: string;
  handler?: string;
  source?: string;
  /** input fields the boundary declares (← ParsedPage.formFields) — the Input facet. */
  inputs?: string[];
  /** domain events this route's handler emits (traced through the code), name-matched
   * to StructureExtract.events. A route may trigger several (1-to-many). */
  events?: string[];
}

/** An entity in the information model: a name, its attributes, and what it depends on. */
export interface EntityRecord {
  name: string;
  attributes: string[];
  /** names of entities this one references (FKs) — the topology signal. */
  dependsOn?: string[];
  /** provenance, e.g. "db/schema.sql:orders". */
  source?: string;
}

/** A usecase: the bridge from a route to the entities it touches, and how (CRUD). */
export interface UsecaseRecord {
  name: string;
  /** the primary entity (= entities[0]); kept for the 1:1 route→entity anchor
   * used by boundary/emit. */
  entity: string;
  /** all entities this usecase touches (1-to-many); entities[0] === entity.
   * Optional for back-compat; consumers fall back to [entity]. */
  entities?: string[];
  /** the route that triggers it, if any — links the route edge to the domain. */
  route?: { method: string; path: string };
  crud: Crud[];
}

/**
 * A code-level CRUD operation on an entity (← rdra EntityOperation). The STRONGEST
 * CRUD signal: it sees through HTTP methods to what the code actually does
 * (OrderService.createOrder() → Stock::decrement() = Update on Stock).
 */
export interface EntityOperation {
  /** the entity class the operation targets, e.g. "Stock" / "Hotel". */
  entityClass: string;
  operation: "Create" | "Read" | "Update" | "Delete";
  methodSignature?: string;
  callChain?: string[];
}

/**
 * A domain event as found in the CODE (as-built), the structure-side counterpart to
 * the intent layer's GlossaryEvent. Together with state transitions this is the
 * mechanical intent↔structure diff axis. Attribution (aggregate/trigger) is
 * best-effort from static signals; unknowns stay undefined rather than guessed.
 */
export interface StructureEvent {
  /** the event identifier as it appears in code, e.g. "OrderPlaced". */
  name: string;
  /** the enclosing class/type that raises it, when statically resolvable. */
  aggregate?: string;
  /** the method the emit happens in, when known. */
  trigger?: string;
  /** payload field names, when a declaration exposes them. */
  properties?: string[];
  /** provenance, "path:line". */
  source?: string;
}

/**
 * A state transition found in the CODE: an assignment of a literal to a status/state
 * field. `from` is usually null — static analysis sees the target state, not the
 * predecessor — and that's recorded honestly rather than invented.
 */
export interface StructureStateTransition {
  /** the enclosing class/type owning the state field, when resolvable. */
  aggregate?: string;
  /** source state; null when static analysis can't determine it. */
  from?: string | null;
  /** target state — the literal assigned. */
  to: string;
  /** the method where the assignment happens, when known. */
  trigger?: string | null;
  /** an event raised alongside the transition, when co-located. */
  event?: string | null;
  /** provenance, "path:line". */
  source?: string;
}

export interface StructureExtract {
  routes: RouteRecord[];
  entities: EntityRecord[];
  usecases: UsecaseRecord[];
  /** code-level CRUD operations (optional; the highest-priority CRUD signal). */
  entityOperations?: EntityOperation[];
  /** domain events found in code — the intent↔structure diff axis. */
  events?: StructureEvent[];
  /** state transitions found in code (status/state literal assignments). */
  stateTransitions?: StructureStateTransition[];
  /**
   * Human CRUD overrides, burned in from the corrections overlay. When present for an
   * entity, this WINS over the computed CRUD — a person's correction is authoritative.
   */
  crudOverrides?: Record<string, Crud[]>;
}
