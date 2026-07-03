// packages/contract/src/route.ts
//
// The route key is the strong, mechanical join for the structure↔behavior edge (and, per P5,
// the tx↔route join the viewer needs). It lives on the spine (contract) — every layer emits raw
// route strings (structure: templated paths like "/orders/:id"; behavior: concrete URLs like
// "/orders/123") and normalizeRoute collapses both to one comparable key. Originally lived in
// reconciler (ADR-0004); moved here so the viewer (which depends on contract only) can join
// communication-log routes without pulling in the reconciler package.

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^[0-9a-f]{16,}$/i;

/** Does this path segment look like an identifier rather than a fixed name? */
function isParamSegment(segment: string): boolean {
  if (segment.startsWith(":")) return true; // already templated
  if (segment.startsWith("{") && segment.endsWith("}")) return true; // {id} style
  if (NUMERIC.test(segment)) return true;
  if (UUID.test(segment)) return true;
  if (HEX_ID.test(segment)) return true;
  return false;
}

/**
 * Normalize a raw "METHOD /path" key into a canonical match key.
 * - method upper-cased
 * - path lower-cased, trailing slash stripped (root preserved)
 * - id-shaped segments collapsed to ":id"
 */
export function normalizeRoute(rawRouteKey: string): string {
  const trimmed = rawRouteKey.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const method = (spaceIdx === -1 ? "GET" : trimmed.slice(0, spaceIdx)).toUpperCase();
  const rawPath = spaceIdx === -1 ? trimmed : trimmed.slice(spaceIdx + 1);

  // strip query/hash, lower-case, split
  const pathOnly = rawPath.split(/[?#]/)[0] ?? "";
  const segments = pathOnly
    .toLowerCase()
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (isParamSegment(s) ? ":id" : s));

  const path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return `${method} ${path}`;
}
