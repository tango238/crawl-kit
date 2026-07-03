import { describe, expect, it } from "vitest";
import { applyCorrections, type Correction } from "./corrections.js";
import { buildCrudIndex } from "./crud.js";
import type { StructureExtract } from "./model.js";

function base(): StructureExtract {
  return {
    entities: [
      { name: "hotels", attributes: ["id", "name"] },
      { name: "ab_tests", attributes: ["id"] },
    ],
    routes: [{ method: "GET", path: "/hotels" }],
    usecases: [],
  };
}

describe("applyCorrections", () => {
  it("set-crud overrides the computed CRUD (human wins)", () => {
    const { extract } = applyCorrections(base(), [{ kind: "set-crud", entity: "hotels", crud: ["C", "R", "U", "D"] }]);
    expect(buildCrudIndex(extract).get("hotels")).toEqual(["C", "R", "U", "D"]);
  });

  it("add-entity creates a table the analysis missed (e.g. rooms)", () => {
    const { extract, corrected } = applyCorrections(base(), [
      { kind: "add-entity", entity: "rooms", attributes: ["id", "hotel_id", "number"], dependsOn: ["hotels"] },
    ]);
    const rooms = extract.entities.find((e) => e.name === "rooms");
    expect(rooms?.attributes).toEqual(["id", "hotel_id", "number"]);
    expect(rooms?.dependsOn).toEqual(["hotels"]);
    expect(corrected.has("rooms")).toBe(true);
  });

  it("remove-entity drops a misidentified entity", () => {
    const { extract } = applyCorrections(base(), [{ kind: "remove-entity", entity: "ab_tests" }]);
    expect(extract.entities.map((e) => e.name)).not.toContain("ab_tests");
  });

  it("rename-entity repoints dependsOn references", () => {
    const e = base();
    e.entities[0]!.dependsOn = ["ab_tests"];
    const { extract } = applyCorrections(e, [{ kind: "rename-entity", from: "ab_tests", to: "experiments" }]);
    expect(extract.entities.find((x) => x.name === "hotels")?.dependsOn).toEqual(["experiments"]);
  });

  it("set/add-attributes update columns", () => {
    const { extract } = applyCorrections(base(), [
      { kind: "set-attributes", entity: "hotels", attributes: ["id", "name", "address"] },
      { kind: "add-attributes", entity: "hotels", attributes: ["phone"] },
    ]);
    expect(extract.entities.find((e) => e.name === "hotels")?.attributes).toEqual(["id", "name", "address", "phone"]);
  });

  it("skips (does not crash on) corrections to unknown entities and reports them", () => {
    const { skipped } = applyCorrections(base(), [{ kind: "set-crud", entity: "ghost", crud: ["R"] }]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/unknown entity/);
  });

  it("is a pure overlay — re-applying over a fresh extract reproduces the fix (burn-in)", () => {
    const corrections: Correction[] = [
      { kind: "add-entity", entity: "rooms", attributes: ["id"] },
      { kind: "set-crud", entity: "hotels", crud: ["C", "R", "U", "D"] },
    ];
    // a brand-new extract (as if re-analyzed) still gets both corrections
    const run1 = applyCorrections(base(), corrections);
    const run2 = applyCorrections(base(), corrections);
    expect(run2.extract.entities.map((e) => e.name).sort()).toEqual(run1.extract.entities.map((e) => e.name).sort());
    expect(buildCrudIndex(run2.extract).get("hotels")).toEqual(["C", "R", "U", "D"]);
  });
});
