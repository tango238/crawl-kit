// packages/viewer/src/intent-model.test.ts
//
// buildIntentModel() joins intent.nodes.json (events + transitions) with
// intent.aggregates.json (the aggregate roster) and mapping.aggregate-entity.json
// (aggregate → structure entity evidence) into one IntentModel. joinIntentModel is
// the pure join (no I/O, unit-tested directly); buildIntentModel is tested against
// a temp workspace fixture, missing-file-tolerant.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIntentModel, joinIntentModel } from "./intent-model.js";

describe("joinIntentModel (pure)", () => {
  it("maps intent:event/ nodes to {name, aggregate, trigger, properties, consumer}", () => {
    const nodes = [
      {
        nodeId: "intent:event/order-placed",
        raw: {
          eventName: "OrderPlaced",
          aggregate: "Order",
          trigger: "checkout submitted",
          properties: ["orderId", "total"],
          consumer: "billing",
        },
      },
    ];
    const model = joinIntentModel(nodes, { aggregates: [] }, { aggregates: [] });
    expect(model.events).toEqual([
      {
        name: "OrderPlaced",
        aggregate: "Order",
        trigger: "checkout submitted",
        properties: ["orderId", "total"],
        consumer: "billing",
      },
    ]);
  });

  it("maps intent:transition/ nodes to {aggregate, from, to, trigger, event}", () => {
    const nodes = [
      {
        nodeId: "intent:transition/order/pending--paid",
        raw: { aggregate: "Order", from: "pending", to: "paid", trigger: "PayOrder", event: "OrderPaid" },
      },
    ];
    const model = joinIntentModel(nodes, { aggregates: [] }, { aggregates: [] });
    expect(model.transitions).toEqual([
      { aggregate: "Order", from: "pending", to: "paid", trigger: "PayOrder", event: "OrderPaid" },
    ]);
  });

  it("joins aggregate roster members with mapped entities by conceptId, preserving confidence/evidence/repo", () => {
    const aggregateDoc = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
        },
      ],
    };
    const mapping = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          entities: [
            {
              nodeId: "structure:entity/orders",
              entity: "orders",
              repo: "shop-api",
              confidence: 0.9,
              evidence: "name match",
            },
          ],
        },
      ],
    };
    const model = joinIntentModel([], aggregateDoc, mapping);
    expect(model.aggregates).toEqual([
      {
        name: "Order",
        conceptId: "concept:order",
        members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
        entities: [{ entity: "orders", repo: "shop-api", confidence: 0.9, evidence: "name match" }],
      },
    ]);
  });

  it("omits repo from an entity when the mapping doesn't carry one", () => {
    const aggregateDoc = { aggregates: [{ conceptId: "concept:order", name: "Order", members: [] }] };
    const mapping = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          entities: [{ nodeId: "structure:entity/orders", entity: "orders", confidence: 0.95, evidence: "reconciled to aggregate root" }],
        },
      ],
    };
    const model = joinIntentModel([], aggregateDoc, mapping);
    expect(model.aggregates[0]!.entities).toEqual([
      { entity: "orders", confidence: 0.95, evidence: "reconciled to aggregate root" },
    ]);
  });

  it("gives an aggregate an empty entities list when the mapping has no match", () => {
    const aggregateDoc = { aggregates: [{ conceptId: "concept:cart", name: "Cart", members: [] }] };
    const model = joinIntentModel([], aggregateDoc, { aggregates: [] });
    expect(model.aggregates).toEqual([{ name: "Cart", conceptId: "concept:cart", members: [], entities: [] }]);
  });

  it("maps top-level unassigned entities with repo when present", () => {
    const mapping = {
      aggregates: [],
      unassigned: [
        { nodeId: "structure:entity/logs", entity: "logs", repo: "infra" },
        { nodeId: "structure:entity/scratch", entity: "scratch" },
      ],
    };
    const model = joinIntentModel([], { aggregates: [] }, mapping);
    expect(model.unassigned).toEqual([
      { entity: "logs", repo: "infra" },
      { entity: "scratch" },
    ]);
  });

  it("gives an empty unassigned list when the mapping has none", () => {
    const model = joinIntentModel([], { aggregates: [] }, { aggregates: [] });
    expect(model.unassigned).toEqual([]);
  });

  it("ignores non-event/transition nodes", () => {
    const nodes = [{ nodeId: "intent:concept/order", raw: { conceptId: "concept:order" } }];
    const model = joinIntentModel(nodes, { aggregates: [] }, { aggregates: [] });
    expect(model.events).toEqual([]);
    expect(model.transitions).toEqual([]);
  });
});

interface Workspace {
  root: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "ck-viewer-intent-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
  await mkdir(join(root, "data"), { recursive: true });
  return { root };
}

const prevCwd = process.cwd();
afterEach(() => {
  process.chdir(prevCwd);
});

describe("buildIntentModel (I/O)", () => {
  it("returns all-empty arrays when no data files exist", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    const model = await buildIntentModel();
    expect(model).toEqual({ events: [], aggregates: [], transitions: [], unassigned: [] });
  });

  it("returns all-empty arrays when files are corrupt JSON", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);
    await writeFile(join(root, "data", "intent.nodes.json"), "{not json", "utf8");

    const model = await buildIntentModel();
    expect(model.events).toEqual([]);
  });

  it("reads and joins real fixture files end-to-end", async () => {
    const { root } = await makeWorkspace();
    process.chdir(root);

    await writeFile(
      join(root, "data", "intent.nodes.json"),
      JSON.stringify([
        {
          nodeId: "intent:event/order-placed",
          raw: { eventName: "OrderPlaced", aggregate: "Order", trigger: null, properties: [], consumer: null },
        },
      ]),
      "utf8",
    );
    await writeFile(
      join(root, "data", "intent.aggregates.json"),
      JSON.stringify({
        aggregates: [{ conceptId: "concept:order", name: "Order", members: [] }],
      }),
      "utf8",
    );
    await writeFile(
      join(root, "data", "mapping.aggregate-entity.json"),
      JSON.stringify({
        generatedAt: "2026-01-01T00:00:00.000Z",
        aggregates: [
          {
            conceptId: "concept:order",
            name: "Order",
            entities: [{ nodeId: "structure:entity/orders", entity: "orders", confidence: 1, evidence: "x" }],
          },
        ],
        unassigned: [{ nodeId: "structure:entity/scratch", entity: "scratch", repo: "infra" }],
      }),
      "utf8",
    );

    const model = await buildIntentModel();
    expect(model.events).toHaveLength(1);
    expect(model.events[0]!.name).toBe("OrderPlaced");
    expect(model.aggregates).toEqual([
      {
        name: "Order",
        conceptId: "concept:order",
        members: [],
        entities: [{ entity: "orders", confidence: 1, evidence: "x" }],
      },
    ]);
    expect(model.unassigned).toEqual([{ entity: "scratch", repo: "infra" }]);
  });
});
