import { describe, expect, it } from "vitest";
import { buildCrudIndex, entityCrud, normalizeEntityKey } from "./crud.js";
import type { StructureExtract } from "./model.js";

describe("normalizeEntityKey", () => {
  it("collapses class/table/plural variants to one key", () => {
    expect(normalizeEntityKey("Hotel")).toBe("hotel");
    expect(normalizeEntityKey("hotels")).toBe("hotel");
    expect(normalizeEntityKey("room_types")).toBe("room type");
    expect(normalizeEntityKey("hotel_images")).toBe("hotel image"); // NOT "hotel"
  });
});

describe("entityCrud — route-by-path (the gap that was missing)", () => {
  const extract: StructureExtract = {
    entities: [{ name: "hotels", attributes: [] }, { name: "hotel_images", attributes: [] }],
    routes: [
      { method: "GET", path: "/hotels" },
      { method: "POST", path: "/hotels" },
      { method: "PUT", path: "/hotels/{hotelId}/email_preferences" },
      { method: "DELETE", path: "/hotels/{hotelId}" },
      { method: "GET", path: "/hotel_images" },
    ],
    usecases: [],
  };

  it("derives full CRUD for hotels from the routes that name it", () => {
    expect(entityCrud("hotels", extract)).toEqual(["C", "R", "U", "D"]);
  });

  it("does not leak hotels routes into hotel_images (segment match, not substring)", () => {
    // hotel_images only has its own GET — the /hotels/* writes must NOT count here
    expect(entityCrud("hotel_images", extract)).toEqual(["R"]);
  });
});

describe("entityCrud — entity_operations (code-truth, strongest)", () => {
  it("picks up indirect operations the HTTP method can't see", () => {
    const extract: StructureExtract = {
      entities: [{ name: "stocks", attributes: [] }],
      routes: [], // no route names "stock"
      usecases: [],
      entityOperations: [
        { entityClass: "Stock", operation: "Update", methodSignature: "Stock::decrement('qty')" },
      ],
    };
    expect(entityCrud("stocks", extract)).toEqual(["U"]);
  });
});

describe("buildCrudIndex — union of all sources", () => {
  it("combines routes + usecases + operations per entity", () => {
    const extract: StructureExtract = {
      entities: [{ name: "orders", attributes: [] }],
      routes: [{ method: "GET", path: "/orders" }, { method: "DELETE", path: "/orders/{id}" }],
      usecases: [{ name: "CreateOrder", entity: "orders", crud: ["C"] }],
      entityOperations: [{ entityClass: "Order", operation: "Update" }],
    };
    expect(buildCrudIndex(extract).get("orders")).toEqual(["C", "R", "U", "D"]);
  });
});
