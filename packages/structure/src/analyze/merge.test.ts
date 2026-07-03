import { describe, expect, it } from "vitest";
import { emptyFragment, type StructureFragment } from "./fragments.js";
import { mergeFragments } from "./merge.js";
import type { ParsedController, ParsedModel, ParsedRoute } from "./source-parser.js";

const route = (over: Partial<ParsedRoute>): ParsedRoute => ({
  method: "GET", path: "/", controller: "", action: "", middleware: [], prefix: "", ...over,
});
const ctrl = (over: Partial<ParsedController>): ParsedController => ({
  classNameRef: "", filePath: "", namespace: "", methods: [], docblocks: {}, requestRules: {}, entityOperations: {}, ...over,
});
const model = (over: Partial<ParsedModel>): ParsedModel => ({
  className: "", tableName: "", fillable: [], relationships: [], casts: {}, scopes: [], ...over,
});
const frag = (unitId: string, over: Partial<StructureFragment>): StructureFragment => ({
  ...emptyFragment(unitId, "h", 1), ...over,
});

describe("mergeFragments — route dedup by normalizeRoute", () => {
  it("collapses id-shaped duplicates into one route", () => {
    const merged = mergeFragments([
      frag("u1", { routes: [route({ method: "GET", path: "/users/1" })] }),
      frag("u2", { routes: [route({ method: "GET", path: "/users/2" })] }),
    ]);
    const keys = merged.routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(["GET /users/:id"]);
  });

  it("keeps distinct routes separate and fills empty fields from later duplicates", () => {
    const merged = mergeFragments([
      frag("u1", { routes: [route({ method: "GET", path: "/users" })] }),
      frag("u2", { routes: [route({ method: "GET", path: "/users", controller: "UserController", action: "index" })] }),
      frag("u3", { routes: [route({ method: "POST", path: "/users" })] }),
    ]);
    expect(merged.routes).toHaveLength(2);
    const get = merged.routes.find((r) => r.method === "GET")!;
    expect(get.controller).toBe("UserController");
    expect(get.action).toBe("index");
  });
});

describe("mergeFragments — controller & model merge", () => {
  it("unions requestRules and methods across controller fragments", () => {
    const merged = mergeFragments([
      frag("u1", { controllers: [ctrl({ classNameRef: "UserController", requestRules: { store: ["name:required"] }, methods: ["store"] })] }),
      frag("u2", { controllers: [ctrl({ classNameRef: "UserController", requestRules: { update: ["email:email"] }, methods: ["update"] })] }),
    ]);
    expect(merged.controllers).toHaveLength(1);
    expect(merged.controllers[0].requestRules).toEqual({ store: ["name:required"], update: ["email:email"] });
    expect(merged.controllers[0].methods.sort()).toEqual(["store", "update"]);
  });

  it("unions model fillable and prefers a non-empty tableName", () => {
    const merged = mergeFragments([
      frag("u1", { models: [model({ className: "User", fillable: ["name"] })] }),
      frag("u2", { models: [model({ className: "User", tableName: "users", fillable: ["email"] })] }),
    ]);
    expect(merged.models).toHaveLength(1);
    expect(merged.models[0].tableName).toBe("users");
    expect(merged.models[0].fillable.sort()).toEqual(["email", "name"]);
  });
});

describe("mergeFragments — cross-unit ref resolution", () => {
  it("derives a route->controller ref when a route names a known controller", () => {
    const merged = mergeFragments([
      frag("u1", { routes: [route({ method: "GET", path: "/users", controller: "UserController" })] }),
      frag("u2", { controllers: [ctrl({ classNameRef: "UserController" })] }),
    ]);
    expect(merged.refs).toContainEqual({ from: "GET /users", to: "UserController", kind: "route->controller" });
  });

  it("preserves explicit refs and dedups them", () => {
    const r = { from: "UserController", to: "User", kind: "controller->model" };
    const merged = mergeFragments([frag("u1", { refs: [r] }), frag("u2", { refs: [r] })]);
    expect(merged.refs.filter((x) => x.kind === "controller->model")).toHaveLength(1);
  });

  it("does not derive a route->controller ref when the controller is unknown", () => {
    const merged = mergeFragments([
      frag("u1", { routes: [route({ method: "GET", path: "/x", controller: "GhostController" })] }),
    ]);
    expect(merged.refs.some((r) => r.kind === "route->controller")).toBe(false);
  });
});

describe("mergeFragments — robustness", () => {
  it("returns empty structure for no fragments", () => {
    expect(mergeFragments([])).toEqual({ routes: [], controllers: [], models: [], refs: [] });
  });

  it("survives fragments with empty arrays", () => {
    const merged = mergeFragments([frag("u1", {}), frag("u2", {})]);
    expect(merged.routes).toEqual([]);
  });
});
