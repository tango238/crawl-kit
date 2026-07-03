// packages/verification/src/index.ts
export * from "./model.js";
export { verifyUnified, buildReport } from "./verify.js";
export { adjudicate } from "./adjudicate.js";
export {
  verifyBoundary,
  verifyBoundaries,
  assembleBoundaries,
  buildBoundaryReport,
  type BoundaryInput,
  type BoundaryFinding,
  type BoundaryRoute,
  type BoundaryReport,
  type BoundaryFacet,
  type BoundaryKind,
} from "./boundary.js";
