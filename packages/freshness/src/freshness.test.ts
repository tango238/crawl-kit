import { describe, expect, it } from "vitest";
import { emptyStore } from "./model.js";
import {
  planBehaviorCrawl,
  recordBehavior,
  recordStructure,
  routeDelta,
  staleDirs,
  stalePages,
} from "./freshness.js";

const T0 = new Date("2026-06-29T00:00:00Z");
const later = (secs: number) => new Date(T0.getTime() + secs * 1000);

describe("staleDirs", () => {
  it("flags a never-seen directory as new", () => {
    const cur = new Map([["src", { "src/a.ts": "h1" }]]);
    expect(staleDirs(emptyStore(100), cur, T0)).toEqual([{ dir: "src", reason: "new" }]);
  });

  it("skips a directory whose hashes are unchanged and within TTL", () => {
    const cur = new Map([["src", { "src/a.ts": "h1" }]]);
    const store = recordStructure(emptyStore(100), cur, T0);
    expect(staleDirs(store, cur, later(50))).toEqual([]); // 50s < 100s TTL, same hash
  });

  it("flags a directory when a contained file's content hash changed", () => {
    const store = recordStructure(emptyStore(1000), new Map([["src", { "src/a.ts": "h1" }]]), T0);
    const changed = new Map([["src", { "src/a.ts": "h2" }]]); // same path, new hash (content edit)
    expect(staleDirs(store, changed, later(10))).toEqual([{ dir: "src", reason: "changed" }]);
  });

  it("flags a directory when a file is added or removed", () => {
    const store = recordStructure(emptyStore(1000), new Map([["src", { "src/a.ts": "h1" }]]), T0);
    const added = new Map([["src", { "src/a.ts": "h1", "src/b.ts": "h9" }]]);
    expect(staleDirs(store, added, later(10))[0]?.reason).toBe("changed");
  });

  it("flags a directory once the TTL elapses even if unchanged", () => {
    const cur = new Map([["src", { "src/a.ts": "h1" }]]);
    const store = recordStructure(emptyStore(100), cur, T0);
    expect(staleDirs(store, cur, later(101))).toEqual([{ dir: "src", reason: "ttl" }]);
  });
});

describe("routeDelta", () => {
  it("computes added and removed routes", () => {
    expect(routeDelta(["GET /a", "GET /b"], ["GET /b", "GET /c"])).toEqual({
      added: ["GET /c"],
      removed: ["GET /a"],
    });
  });
});

describe("stalePages", () => {
  const pages = [{ route: "GET /orders", viewFiles: { "views/orders.tsx": "v1" } }];

  it("crawls a route structure just added", () => {
    const store = recordBehavior(emptyStore(1000), pages, T0);
    const r = stalePages(store, pages, later(1), new Set(["GET /orders"]));
    expect(r).toEqual([{ route: "GET /orders", reason: "new" }]);
  });

  it("skips a fresh, unchanged page within TTL", () => {
    const store = recordBehavior(emptyStore(1000), pages, T0);
    expect(stalePages(store, pages, later(10))).toEqual([]);
  });

  it("re-crawls when the page's view file changed", () => {
    const store = recordBehavior(emptyStore(1000), pages, T0);
    const edited = [{ route: "GET /orders", viewFiles: { "views/orders.tsx": "v2" } }];
    expect(stalePages(store, edited, later(10))[0]?.reason).toBe("changed");
  });
});

describe("planBehaviorCrawl", () => {
  it("crawls added routes, skips fresh ones, drops removed ones", () => {
    // previously crawled /a and /b at T0
    const store = recordBehavior(emptyStore(1000), [
      { route: "GET /a", viewFiles: {} },
      { route: "GET /b", viewFiles: {} },
    ], T0);
    // structure now reports /a (still) and /c (new); /b is gone
    const plan = planBehaviorCrawl(["GET /a", "GET /c"], store, later(10));
    expect(plan.toCrawl.map((c) => c.route)).toEqual(["GET /c"]); // /a fresh within TTL
    expect(plan.toSkip).toEqual(["GET /a"]);
    expect(plan.toDrop).toEqual(["GET /b"]);
  });

  it("re-crawls everything once the TTL elapses", () => {
    const store = recordBehavior(emptyStore(100), [{ route: "GET /a", viewFiles: {} }], T0);
    const plan = planBehaviorCrawl(["GET /a"], store, later(101));
    expect(plan.toCrawl.map((c) => c.route)).toEqual(["GET /a"]);
  });
});

describe("recordBehavior", () => {
  it("drops routes that no longer exist when liveRoutes is given", () => {
    const store = recordBehavior(emptyStore(1000), [
      { route: "GET /a", viewFiles: {} },
      { route: "GET /b", viewFiles: {} },
    ], T0);
    const pruned = recordBehavior(store, [], later(1), ["GET /a"]);
    expect(Object.keys(pruned.behavior)).toEqual(["GET /a"]);
  });
});
