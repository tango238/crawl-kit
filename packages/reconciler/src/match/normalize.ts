// packages/reconciler/src/match/normalize.ts
//
// Cross-layer names never match literally: glossary says "Order", code says
// "orders"; "customerId" vs "customer_id". Normalization is what lets attribute and
// name signals see through camelCase/snake_case/plural skin to the same token.

/** Split a camelCase / snake_case / kebab identifier into lowercase word tokens. */
export function tokenize(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary
    .replace(/[_\-./]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** naive singularization — enough for table/concept names (orders→order, boxes→box). */
function singularize(token: string): string {
  if (token.endsWith("ies") && token.length > 3) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ses") && token.length > 3) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 1) return token.slice(0, -1);
  return token;
}

/** Canonical comparison key for a single identifier: tokens, singularized, joined. */
export function normalizeName(identifier: string): string {
  return tokenize(identifier).map(singularize).join(" ");
}

/** Canonical comparison key for one attribute name (singularization is too aggressive here). */
export function normalizeAttr(attr: string): string {
  return tokenize(attr).join("");
}

/** Jaccard overlap of two string sets. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}
