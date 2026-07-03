// packages/cli/src/commands/structure-merge.test.ts

import { describe, expect, it } from "vitest";
import type { StructureExtract } from "@crawl-kit/structure";
import type { FileHashes } from "@crawl-kit/freshness";
import { mergedExtract, prefixScan } from "./structure-merge.js";

function extract(overrides: Partial<StructureExtract> = {}): StructureExtract {
  return {
    routes: [{ method: "GET", path: "/orders" }],
    entities: [{ name: "Order", attributes: ["id"] }],
    usecases: [{ name: "ListOrders", entity: "Order", crud: ["R"] }],
    ...overrides,
  };
}

describe("mergedExtract", () => {
  it("0 repos: empty extract", () => {
    expect(mergedExtract(new Map())).toEqual({ routes: [], entities: [], usecases: [] });
  });

  it("1 repo: identity — no repo tags, byte-identical to the repo's own extract", () => {
    const solo = extract();
    const merged = mergedExtract(new Map([["/work/be", solo]]));
    expect(merged).toBe(solo);
    expect((merged.routes[0] as unknown as { repo?: string }).repo).toBeUndefined();
  });

  it("2 repos: every record tagged with repo (basename of abs path), crudOverrides shallow-merged", () => {
    const be = extract({
      routes: [{ method: "GET", path: "/orders" }],
      entities: [{ name: "Order", attributes: ["id"] }],
      usecases: [{ name: "ListOrders", entity: "Order", crud: ["R"] }],
      crudOverrides: { Order: ["C", "R"] },
    });
    const fe = extract({
      routes: [{ method: "GET", path: "/cart" }],
      entities: [{ name: "Cart", attributes: ["id"] }],
      usecases: [{ name: "ViewCart", entity: "Cart", crud: ["R"] }],
      crudOverrides: { Cart: ["R"] },
    });

    const merged = mergedExtract(
      new Map([
        ["/work/be", be],
        ["/work/fe", fe],
      ]),
    );

    expect(merged.routes).toEqual([
      { method: "GET", path: "/orders", repo: "be" },
      { method: "GET", path: "/cart", repo: "fe" },
    ]);
    expect(merged.entities).toEqual([
      { name: "Order", attributes: ["id"], repo: "be" },
      { name: "Cart", attributes: ["id"], repo: "fe" },
    ]);
    expect(merged.usecases).toEqual([
      { name: "ListOrders", entity: "Order", crud: ["R"], repo: "be" },
      { name: "ViewCart", entity: "Cart", crud: ["R"], repo: "fe" },
    ]);
    expect(merged.crudOverrides).toEqual({ Order: ["C", "R"], Cart: ["R"] });
  });

  it("2 repos: crudOverrides key collision — later repo (iteration order) wins", () => {
    const be = extract({ crudOverrides: { Order: ["C"] } });
    const fe = extract({ crudOverrides: { Order: ["R", "U"] } });
    const merged = mergedExtract(
      new Map([
        ["/work/be", be],
        ["/work/fe", fe],
      ]),
    );
    expect(merged.crudOverrides).toEqual({ Order: ["R", "U"] });
  });

  it("2 repos: missing optional arrays (entityOperations/events/stateTransitions) handled as empty", () => {
    const be = extract();
    const fe = extract();
    const merged = mergedExtract(
      new Map([
        ["/work/be", be],
        ["/work/fe", fe],
      ]),
    );
    expect(merged.entityOperations).toEqual([]);
    expect(merged.events).toEqual([]);
    expect(merged.stateTransitions).toEqual([]);
  });

  it("2 repos: optional arrays present on both are concatenated with repo tags", () => {
    const be = extract({
      entityOperations: [{ entityClass: "Order", operation: "Create", callChain: ["OrderService.create"] }],
      events: [{ name: "OrderPlaced", source: "be/order.ts" }],
      stateTransitions: [{ aggregate: "Order", from: "new", to: "paid", source: "be/order.ts" }],
    });
    const fe = extract();
    const merged = mergedExtract(
      new Map([
        ["/work/be", be],
        ["/work/fe", fe],
      ]),
    );
    expect(merged.entityOperations).toEqual([
      { entityClass: "Order", operation: "Create", callChain: ["OrderService.create"], repo: "be" },
    ]);
    expect(merged.events).toEqual([{ name: "OrderPlaced", source: "be/order.ts", repo: "be" }]);
    expect(merged.stateTransitions).toEqual([
      { aggregate: "Order", from: "new", to: "paid", source: "be/order.ts", repo: "be" },
    ]);
  });
});

describe("prefixScan", () => {
  it("prefixes every non-root dir key with the repo name", () => {
    const scanned = new Map<string, FileHashes>([
      ["src", { "src/a.ts": "hash1" }],
      ["src/lib", { "src/lib/b.ts": "hash2" }],
    ]);
    const prefixed = prefixScan(scanned, "be");
    expect([...prefixed.keys()]).toEqual(["be/src", "be/src/lib"]);
    expect(prefixed.get("be/src")).toEqual({ "src/a.ts": "hash1" });
  });

  it('the repo root ("." from scanByDir) becomes just the repo name', () => {
    const scanned = new Map<string, FileHashes>([["." , { "index.js": "hash0" }]]);
    const prefixed = prefixScan(scanned, "be");
    expect([...prefixed.keys()]).toEqual(["be"]);
  });

  it("empty map handled", () => {
    expect(prefixScan(new Map<string, FileHashes>(), "be")).toEqual(new Map());
  });

  it("two repos sharing a dir name no longer collide once prefixed", () => {
    const beScan = prefixScan(new Map<string, FileHashes>([["src", { "src/a.ts": "h1" }]]), "be");
    const feScan = prefixScan(new Map<string, FileHashes>([["src", { "src/a.ts": "h2" }]]), "fe");
    const combined = new Map([...beScan, ...feScan]);
    expect(combined.size).toBe(2);
    expect(combined.get("be/src")).toEqual({ "src/a.ts": "h1" });
    expect(combined.get("fe/src")).toEqual({ "src/a.ts": "h2" });
  });
});
