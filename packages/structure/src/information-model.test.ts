import { describe, expect, it } from "vitest";
import { buildInformationModel } from "./information-model.js";
import { buildCrudIndex } from "./crud.js";
import { analyzeCrud } from "./gap/crud.js";
import { entityRelationshipDiagram } from "./rdra/diagrams.js";
import type { StructureExtract } from "./model.js";

const extract: StructureExtract = {
  routes: [],
  entities: [
    { name: "orders", attributes: ["id", "total"], dependsOn: ["customers"] },
    { name: "customers", attributes: ["id", "name"] },
  ],
  usecases: [
    { name: "CreateOrder", entity: "orders", crud: ["C"] },
    { name: "ReadOrder", entity: "orders", crud: ["R"] },
    { name: "ListCustomers", entity: "customers", crud: ["R"] },
  ],
};

describe("buildInformationModel", () => {
  const model = buildInformationModel(extract);

  it("wires reverse dependency edges", () => {
    expect(model.entities.get("customers")?.dependedOnBy).toEqual(["orders"]);
  });

  it("still wires usecasesByEntity for diagrams", () => {
    expect(model.usecasesByEntity.get("orders")?.length).toBe(2);
  });
});

describe("analyzeCrud", () => {
  it("flags entities missing CRUD operations", () => {
    const report = analyzeCrud(extract);
    const orders = report.gaps.find((g) => g.entity === "orders");
    expect(orders?.missing.sort()).toEqual(["D", "U"]);
  });
});

describe("entityRelationshipDiagram", () => {
  it("renders a Mermaid erDiagram with the dependency edge", () => {
    const mermaid = entityRelationshipDiagram(buildInformationModel(extract));
    expect(mermaid).toContain("erDiagram");
    expect(mermaid).toContain("orders ||--o{ customers");
  });
});
