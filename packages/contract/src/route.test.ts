import { describe, expect, it } from "vitest";
import { normalizeRoute } from "./route.js";

describe("normalizeRoute", () => {
  it("collapses a concrete numeric id to :id, matching a templated path", () => {
    expect(normalizeRoute("GET /orders/123")).toBe("GET /orders/:id");
    expect(normalizeRoute("GET /orders/:id")).toBe("GET /orders/:id");
  });

  it("treats the two sides of the structure↔behavior edge as the same key", () => {
    expect(normalizeRoute("GET /orders/123")).toBe(normalizeRoute("GET /orders/:id"));
  });

  it("collapses uuids and long hex ids", () => {
    expect(normalizeRoute("GET /users/4f9d2e1a-1234-4abc-8def-0123456789ab")).toBe(
      "GET /users/:id",
    );
    expect(normalizeRoute("GET /blobs/deadbeefdeadbeef")).toBe("GET /blobs/:id");
  });

  it("upper-cases method, lower-cases path, strips trailing slash and query", () => {
    expect(normalizeRoute("get /Orders/")).toBe("GET /orders");
    expect(normalizeRoute("GET /orders?page=2")).toBe("GET /orders");
  });

  it("handles {id}-style templates", () => {
    expect(normalizeRoute("GET /orders/{id}")).toBe("GET /orders/:id");
  });

  it("preserves root path", () => {
    expect(normalizeRoute("GET /")).toBe("GET /");
  });

  it("does not collapse alphabetic segments", () => {
    expect(normalizeRoute("POST /admin/reindex")).toBe("POST /admin/reindex");
  });
});
