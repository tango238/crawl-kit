// packages/viewer/src/index.ts
// Programmatic API of the viewer — the diff model + its renderer + the assembler,
// consumed by the crawl-kit CLI (and anyone embedding the side-by-side view).

export { apiRoutes, readTransactionsRaw } from "./api.js";
export { assembleDiff, type AssembleOptions } from "./diff-assemble.js";
export {
  buildDiffView,
  type DiffView,
  type DiffRow,
  type Cell,
  type Candidate,
  type VerificationFinding,
  type BoundaryFindingView,
  type BoundaryRouteView,
  type IntentAxis,
  type StructureAxis,
  type BehaviorAxis,
  type RouteEventLink,
  type EventRouteRow,
  type DiffViewInputs,
} from "./diff-view.js";
export { buildViewModel, type ViewModel } from "./view-model.js";
export {
  buildDashboardModel,
  buildGuidance,
  type DashboardModel,
  type DashboardArtifacts,
  type GuidanceItem,
} from "./dashboard-model.js";
export {
  buildIntentModel,
  joinIntentModel,
  type IntentModel,
  type IntentEvent,
  type IntentTransition,
  type IntentAggregate,
  type IntentAggregateMember,
  type IntentAggregateEntity,
  type IntentUnassignedEntity,
} from "./intent-model.js";
export {
  buildTrafficModel,
  readSitemapModel,
  extractStructureRoutes,
  extractTxPersistence,
  joinTrafficRoutes,
  joinTrafficPages,
  type TrafficModel,
  type TrafficRouteGroup,
  type TrafficTx,
  type TrafficPage,
  type TrafficPageElement,
  type StructureRoute,
  type Sitemap,
  type SitemapNode,
} from "./traffic-model.js";
