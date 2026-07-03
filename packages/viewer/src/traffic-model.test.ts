// packages/viewer/src/traffic-model.test.ts
//
// buildTrafficModel() joins structure routes (structure:route/ nodes) against
// behavior.transactions.jsonl (grouped by normalizeRoute), attaches persisted
// verdicts from behavior:tx/ nodes, and derives the pages view from
// behavior.edges.json filtered to URLs whose path matches a structure GET route.
// readSitemapModel() passes behavior.sitemap.json through untouched.
//
// extractStructureRoutes / extractTxPersistence / joinTrafficRoutes / joinTrafficPages
// are pure (no I/O) and unit-tested directly; buildTrafficModel + readSitemapModel are
// tested against a temp workspace fixture.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTrafficModel,
  enrichSitemap,
  extractStructureRoutes,
  extractTxPersistence,
  joinPageMutations,
  joinTrafficPages,
  joinTrafficRoutes,
  readSitemapModel,
} from "./traffic-model.js";

describe("extractStructureRoutes (pure)", () => {
  it("extracts method/path from structure:route/ nodes' raw payload", () => {
    const nodes = [
      {
        nodeId: "structure:route/GET /orders/:id",
        route: "GET /orders/:id",
        raw: { kind: "route", method: "GET", path: "/orders/:id" },
      },
      { nodeId: "structure:entity/orders", raw: { kind: "entity" } },
    ];
    expect(extractStructureRoutes(nodes)).toEqual([{ route: "GET /orders/:id", method: "GET", path: "/orders/:id" }]);
  });
});

describe("extractTxPersistence (pure)", () => {
  it("keys persisted verdicts by the tx node's normalized route", () => {
    const nodes = [
      {
        nodeId: "behavior:tx/POST /orders",
        route: "POST /orders",
        raw: { kind: "transaction", method: "POST", path: "/orders", ok: true },
        persisted: "yes" as const,
      },
      { nodeId: "behavior:page/x", raw: {} },
    ];
    const map = extractTxPersistence(nodes);
    expect(map.get("POST /orders")).toBe("yes");
    expect(map.size).toBe(1);
  });

  it("skips tx nodes with no persisted field", () => {
    const nodes = [{ nodeId: "behavior:tx/GET /orders", route: "GET /orders", raw: {} }];
    expect(extractTxPersistence(nodes).size).toBe(0);
  });

  it("resolves to a stable per-route verdict when multiple per-seq nodes share one route", () => {
    // Per-transaction mutation nodes: distinct #seq nodeIds, SAME route + SAME (route-derived)
    // verdict. The route-level aggregation must stay a single entry keyed by route.
    const nodes = [
      {
        nodeId: "behavior:tx/POST /orders#1",
        route: "POST /orders",
        raw: { kind: "transaction", method: "POST", path: "/orders", ok: true },
        persisted: "yes" as const,
      },
      {
        nodeId: "behavior:tx/POST /orders#2",
        route: "POST /orders",
        raw: { kind: "transaction", method: "POST", path: "/orders", ok: true },
        persisted: "yes" as const,
      },
    ];
    const map = extractTxPersistence(nodes);
    expect(map.get("POST /orders")).toBe("yes");
    expect(map.size).toBe(1);
  });
});

describe("joinTrafficRoutes (pure)", () => {
  const structureRoutes = [{ route: "POST /orders/:id/cancel", method: "POST", path: "/orders/:id/cancel" }];

  it("groups transactions matching a structure route by normalized key", () => {
    const txs = [
      {
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        stage: "scenario",
        method: "POST",
        path: "/orders/42/cancel",
        status: 200,
        ok: true,
      },
    ];
    const groups = joinTrafficRoutes(structureRoutes, txs, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.route).toBe("POST /orders/:id/cancel");
    expect(groups[0]!.method).toBe("POST");
    expect(groups[0]!.key).toBe("POST /orders/:id/cancel");
    expect(groups[0]!.pathKey).toBe("/orders/:id/cancel");
    expect(groups[0]!.txs).toEqual([{ seq: 1, ts: "2026-01-01T00:00:00.000Z", stage: "scenario", status: 200, ok: true }]);
  });

  it("excludes transactions that don't match any structure route", () => {
    const txs = [
      { seq: 1, ts: "t", stage: "crawl", method: "GET", path: "/unrelated", ok: true },
    ];
    expect(joinTrafficRoutes(structureRoutes, txs, new Map())).toEqual([]);
  });

  it("attaches persisted from the tx-persistence map, keyed by normalized route", () => {
    const txs = [
      { seq: 1, ts: "t", stage: "scenario", method: "POST", path: "/orders/42/cancel", status: 200, ok: true },
    ];
    const persisted = new Map([["POST /orders/:id/cancel", "yes" as const]]);
    const groups = joinTrafficRoutes(structureRoutes, txs, persisted);
    expect(groups[0]!.txs[0]!.persisted).toBe("yes");
  });

  it("carries requestQuery/requestBody/responseBody through when present", () => {
    const txs = [
      {
        seq: 1,
        ts: "t",
        stage: "scenario",
        method: "POST",
        path: "/orders/42/cancel",
        ok: true,
        requestQuery: { reason: "changed-mind" },
        requestBody: '{"reason":"x"}',
        responseBody: '{"status":"cancelled"}',
      },
    ];
    const groups = joinTrafficRoutes(structureRoutes, txs, new Map());
    expect(groups[0]!.txs[0]).toMatchObject({
      requestQuery: { reason: "changed-mind" },
      requestBody: '{"reason":"x"}',
      responseBody: '{"status":"cancelled"}',
    });
  });
});

describe("joinTrafficRoutes pageUrl threading (pure)", () => {
  const structureRoutes = [{ route: "POST /orders/:id/cancel", method: "POST", path: "/orders/:id/cancel" }];

  it("carries the owning pageUrl through into the tx entry when present", () => {
    const txs = [
      {
        seq: 1,
        ts: "t",
        stage: "scenario",
        method: "POST",
        path: "/orders/42/cancel",
        ok: true,
        pageUrl: "https://app.test/orders/42",
      },
    ];
    const groups = joinTrafficRoutes(structureRoutes, txs, new Map());
    expect(groups[0]!.txs[0]!.pageUrl).toBe("https://app.test/orders/42");
  });

  it("omits pageUrl on the tx entry when the tx has none", () => {
    const txs = [{ seq: 1, ts: "t", stage: "scenario", method: "POST", path: "/orders/42/cancel", ok: true }];
    const groups = joinTrafficRoutes(structureRoutes, txs, new Map());
    expect(groups[0]!.txs[0]!).not.toHaveProperty("pageUrl");
  });
});

describe("joinPageMutations (pure)", () => {
  it("maps normalized page URL -> mutation tx summaries (non-GET only)", () => {
    const txs = [
      { seq: 1, ts: "t1", stage: "crud", method: "POST", path: "/api/orders", ok: true, status: 201, pageUrl: "https://app.test/orders/new" },
      { seq: 2, ts: "t2", stage: "crud", method: "GET", path: "/api/orders", ok: true, pageUrl: "https://app.test/orders/new" },
      { seq: 3, ts: "t3", stage: "crud", method: "PATCH", path: "/api/orders/9", ok: true, pageUrl: "https://app.test/orders/new" },
    ];
    const map = joinPageMutations(txs);
    expect([...map.keys()]).toEqual(["https://app.test/orders/new"]);
    const summaries = map.get("https://app.test/orders/new")!;
    expect(summaries).toHaveLength(2); // GET excluded
    expect(summaries[0]).toEqual({ seq: 1, ts: "t1", stage: "crud", method: "POST", path: "/api/orders", status: 201, ok: true });
    expect(summaries[1]!.method).toBe("PATCH");
  });

  it("skips txs with no pageUrl", () => {
    const txs = [{ seq: 1, ts: "t", stage: "crud", method: "POST", path: "/api/orders", ok: true }];
    expect(joinPageMutations(txs).size).toBe(0);
  });

  it("normalizes the page URL key (drops query/fragment/trailing slash) — same key both sides", () => {
    const txs = [
      { seq: 1, ts: "t", stage: "crud", method: "POST", path: "/api/x", ok: true, pageUrl: "https://app.test/orders/?tab=1#a" },
    ];
    const map = joinPageMutations(txs);
    expect([...map.keys()]).toEqual(["https://app.test/orders"]);
  });
});

describe("enrichSitemap (pure)", () => {
  it("attaches mutation summaries to nodes whose normalized url matches, recursively", () => {
    const sitemap = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      roots: [
        {
          url: "https://app.test/orders/", // trailing slash — must still match
          children: [{ url: "https://app.test/settings", children: [] }],
        },
      ],
      orphans: [],
    };
    const mutationsByUrl = joinPageMutations([
      { seq: 1, ts: "t", stage: "crud", method: "POST", path: "/api/orders", ok: true, pageUrl: "https://app.test/orders" },
    ]);
    const enriched = enrichSitemap(sitemap, mutationsByUrl);
    expect(enriched.roots[0]!.mutations).toHaveLength(1);
    expect(enriched.roots[0]!.mutations![0]!.method).toBe("POST");
    expect(enriched.roots[0]!.children[0]!.mutations).toBeUndefined();
    // input not mutated
    expect((sitemap.roots[0] as { mutations?: unknown }).mutations).toBeUndefined();
  });

  it("leaves nodes untouched when there are no mutations for their url", () => {
    const sitemap = {
      generatedAt: "g",
      roots: [{ url: "https://app.test/x", children: [] }],
      orphans: [],
    };
    const enriched = enrichSitemap(sitemap, new Map());
    expect(enriched.roots[0]!.mutations).toBeUndefined();
  });
});

describe("joinTrafficPages (pure)", () => {
  const structureRoutes = [{ route: "GET /orders", method: "GET", path: "/orders" }];

  it("groups edges by `from` into {url, elements} for URLs matching a structure GET route", () => {
    const edges = [
      { from: "https://app.test/orders", to: "https://app.test/orders/42", kind: "click" as const, label: "View" },
      { from: "https://app.test/orders", to: "https://app.test/other", kind: "link" as const },
    ];
    const pages = joinTrafficPages(edges, structureRoutes);
    expect(pages).toEqual([
      {
        url: "https://app.test/orders",
        key: "GET /orders",
        pathKey: "/orders",
        elements: [
          { kind: "click", label: "View", to: "https://app.test/orders/42" },
          { kind: "link", to: "https://app.test/other" },
        ],
      },
    ]);
  });

  it("excludes pages whose path has no matching structure route", () => {
    const edges = [{ from: "https://app.test/unmatched", to: "https://app.test/x", kind: "link" as const }];
    expect(joinTrafficPages(edges, structureRoutes)).toEqual([]);
  });

  it("a mutation route's pathKey matches the GET page's pathKey for the same path (POST/PATCH rows can still show screen elements)", () => {
    // GET /orders/:id (the page) and PATCH /orders/:id (the mutation on that same screen) share
    // a path but not a method — `key` (method-inclusive) never joins them; `pathKey` does.
    const routes = [
      { route: "GET /orders/:id", method: "GET", path: "/orders/:id" },
      { route: "PATCH /orders/:id", method: "PATCH", path: "/orders/:id" },
    ];
    const [group] = joinTrafficRoutes(
      routes,
      [{ seq: 1, ts: "t", stage: "scenario", method: "PATCH", path: "/orders/42", ok: true }],
      new Map(),
    );
    const [page] = joinTrafficPages(
      [{ from: "https://app.test/orders/42", to: "https://app.test/orders/42/receipt", kind: "link" as const }],
      routes,
    );
    expect(group!.key).not.toBe(page!.key);
    expect(group!.pathKey).toBe(page!.pathKey);
  });
});

interface Workspace {
  root: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "ck-viewer-traffic-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
  await mkdir(join(root, "data"), { recursive: true });
  return { root };
}

const prevCwd = process.cwd();
afterEach(() => {
  process.chdir(prevCwd);
});

describe("buildTrafficModel (I/O)", () => {
  it("returns empty routes/pages when no data files exist", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    const model = await buildTrafficModel();
    expect(model).toEqual({ routes: [], pages: [] });
  });

  it("skips unparsable jsonl lines instead of throwing", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    await writeFile(
      join(root, "data", "structure.nodes.json"),
      JSON.stringify([
        { nodeId: "structure:route/GET /orders", route: "GET /orders", raw: { kind: "route", method: "GET", path: "/orders" } },
      ]),
      "utf8",
    );
    await writeFile(
      join(root, "data", "behavior.transactions.jsonl"),
      [
        JSON.stringify({ seq: 1, ts: "t1", stage: "crawl", method: "GET", path: "/orders", ok: true }),
        "not json at all",
        "",
      ].join("\n"),
      "utf8",
    );

    const model = await buildTrafficModel();
    expect(model.routes).toHaveLength(1);
    expect(model.routes[0]!.txs).toHaveLength(1);
  });

  it("joins routes + attaches persisted + derives pages end-to-end", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    await writeFile(
      join(root, "data", "structure.nodes.json"),
      JSON.stringify([
        {
          nodeId: "structure:route/POST /orders/:id/cancel",
          route: "POST /orders/:id/cancel",
          raw: { kind: "route", method: "POST", path: "/orders/:id/cancel" },
        },
        {
          nodeId: "structure:route/GET /orders",
          route: "GET /orders",
          raw: { kind: "route", method: "GET", path: "/orders" },
        },
      ]),
      "utf8",
    );
    await writeFile(
      join(root, "data", "behavior.nodes.json"),
      JSON.stringify([
        {
          nodeId: "behavior:tx/POST /orders/:id/cancel",
          route: "POST /orders/:id/cancel",
          raw: { kind: "transaction", method: "POST", path: "/orders/42/cancel", ok: true },
          persisted: "yes",
        },
      ]),
      "utf8",
    );
    await writeFile(
      join(root, "data", "behavior.transactions.jsonl"),
      JSON.stringify({ seq: 1, ts: "t1", stage: "scenario", method: "POST", path: "/orders/42/cancel", status: 200, ok: true }) + "\n",
      "utf8",
    );
    await writeFile(
      join(root, "data", "behavior.edges.json"),
      JSON.stringify({
        runId: "run-1",
        edges: [{ from: "https://app.test/orders", to: "https://app.test/orders/42", kind: "click", label: "View" }],
      }),
      "utf8",
    );

    const model = await buildTrafficModel();
    expect(model.routes).toHaveLength(1);
    expect(model.routes[0]!.route).toBe("POST /orders/:id/cancel");
    expect(model.routes[0]!.key).toBe("POST /orders/:id/cancel");
    expect(model.routes[0]!.pathKey).toBe("/orders/:id/cancel");
    expect(model.routes[0]!.txs[0]!.persisted).toBe("yes");
    expect(model.pages).toEqual([
      {
        url: "https://app.test/orders",
        key: "GET /orders",
        pathKey: "/orders",
        elements: [{ kind: "click", label: "View", to: "https://app.test/orders/42" }],
      },
    ]);
  });
});

describe("readSitemapModel (I/O)", () => {
  it("returns null when behavior.sitemap.json doesn't exist", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);
    expect(await readSitemapModel()).toBeNull();
  });

  it("passes the sitemap through untouched when present", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);
    const sitemap = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      roots: [{ url: "https://app.test/", children: [] }],
      orphans: [],
    };
    await writeFile(join(root, "data", "behavior.sitemap.json"), JSON.stringify(sitemap), "utf8");
    expect(await readSitemapModel()).toEqual(sitemap);
  });
});
