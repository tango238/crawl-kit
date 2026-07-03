// normalizeRoute's implementation and full test suite now live at
// packages/contract/src/route.ts / route.test.ts (moved off the reconciler onto the spine —
// see that file's header comment). This is a compat smoke test: existing import sites
// (`./route.js`, `@crawl-kit/reconciler`) must keep resolving to the same function.
import { describe, expect, it } from "vitest";
import { normalizeRoute } from "./route.js";
import { normalizeRoute as normalizeRouteFromContract } from "@crawl-kit/contract";

describe("normalizeRoute (reconciler re-export)", () => {
  it("re-exports the same function contract exposes", () => {
    expect(normalizeRoute).toBe(normalizeRouteFromContract);
  });

  it("still normalizes routes as before", () => {
    expect(normalizeRoute("GET /orders/123")).toBe("GET /orders/:id");
  });
});
