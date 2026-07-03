import { describe, expect, it } from "vitest";
import { validateRegistry, validateUnified, type Adr, type LayerNode } from "@crawl-kit/contract";
import { reconcile, type ReconcileInput } from "./pipeline.js";

const NOW = "2026-06-27T00:00:00.000Z";

function intentNode(
  name: string,
  attributes: string[],
  opts: { kind?: string; dependsOn?: string[] } = {},
): LayerNode {
  const conceptId = `concept:${name.toLowerCase()}`;
  return {
    nodeId: `intent:concept/${conceptId}`,
    layer: "intent",
    localName: name,
    raw: { conceptId, canonicalName: name, aliases: [], kind: opts.kind, attributes, dependsOn: opts.dependsOn ?? [] },
    source: { tool: "distill-ddd" },
  };
}

function entityNode(name: string, attributes: string[], dependsOn: string[] = []): LayerNode {
  return {
    nodeId: `structure:entity/${name}`,
    layer: "structure",
    localName: name,
    raw: { kind: "entity", attributes, dependsOn, crud: ["C", "R"] },
    source: { tool: "rdra-analyzer" },
  };
}

function routeNode(method: string, path: string, entity?: string): LayerNode {
  const key = `${method} ${path}`;
  return {
    nodeId: `structure:route/${key}`,
    layer: "structure",
    localName: key,
    raw: { kind: "route", method, path, entity },
    route: key,
    source: { tool: "rdra-analyzer" },
  };
}

function behaviorNode(method: string, url: string): LayerNode {
  const key = `${method} ${url}`;
  return {
    nodeId: `behavior:route/${key}`,
    layer: "behavior",
    localName: key,
    raw: { findings: [{ method, url, status: 200 }] },
    route: key,
    source: { tool: "loop-e2e" },
  };
}

const adrs: Adr[] = [
  {
    adrId: "adr:0009",
    title: "Split Customer into Customer + Account",
    status: "accepted",
    date: "2026-03-01",
    affects: ["concept:customer"],
    constraints: [{ kind: "note", from: "concept:customer", text: "accounts is the Account side of the split" }],
  },
  {
    adrId: "adr:0010",
    title: "Payment ↛ Shipping",
    status: "accepted",
    date: "2026-04-15",
    affects: ["concept:payment", "concept:shipment"],
    constraints: [{ kind: "forbid-dependency", from: "concept:payment", to: "concept:shipment", text: "Payment ↛ Shipping" }],
  },
];

function scenario(): ReconcileInput {
  return {
    intent: [
      intentNode("Order", ["id", "customerId", "total"], { kind: "aggregate-root", dependsOn: ["Customer"] }),
      intentNode("Customer", ["id", "name", "email"], { kind: "aggregate-root" }),
      intentNode("Payment", ["id", "orderId", "amount"], { kind: "aggregate-root", dependsOn: ["Order"] }),
      intentNode("Shipment", ["id", "orderId", "carrier"], { kind: "aggregate-root", dependsOn: ["Order"] }),
      intentNode("Refund", ["id", "paymentId", "amount"], { kind: "entity", dependsOn: ["Payment"] }),
    ],
    structure: [
      entityNode("orders", ["id", "customer_id", "total"], ["customers"]),
      entityNode("customers", ["id", "name", "email"]),
      entityNode("payments", ["id", "order_id", "amount"], ["orders", "shipments"]),
      entityNode("shipments", ["id", "order_id", "carrier"], ["orders"]),
      entityNode("order_items", ["id", "order_id", "product_id", "qty"], ["orders"]),
      entityNode("accounts", ["id", "customer_id", "tier"], ["customers"]),
      entityNode("clients", ["id", "name", "phone"]),
      entityNode("outbox", ["id", "event_type", "payload"]),
      entityNode("ab_tests", ["id", "experiment", "variant", "bucket"]),
      routeNode("GET", "/orders", "orders"),
      routeNode("POST", "/payments", "payments"),
      routeNode("POST", "/admin/reindex"),
    ],
    behavior: [behaviorNode("GET", "/orders"), behaviorNode("POST", "/payments"), behaviorNode("GET", "/health")],
    adrs,
  };
}

describe("reconcile — full edge engine", () => {
  it("produces referentially-valid registry + unified", async () => {
    const { registry, unified } = await reconcile(scenario(), { now: NOW });
    expect(() => validateRegistry(registry)).not.toThrow();
    expect(() => validateUnified(unified)).not.toThrow();
  });

  it("classifies every ConceptState the design promises", async () => {
    const { unified } = await reconcile(scenario(), { now: NOW });
    const state = (id: string) => unified.concepts.find((c) => c.conceptId === id)?.state;

    expect(state("concept:order")).toBe("aligned");
    expect(state("concept:customer")).toBe("aligned");
    expect(state("concept:shipment")).toBe("aligned");
    expect(state("concept:payment")).toBe("violates-decision");
    expect(state("concept:refund")).toBe("intent-only");
    expect(state("concept:struct/order_items")).toBe("aggregate-internal");
    expect(state("concept:struct/accounts")).toBe("adjudicated");
    expect(state("concept:struct/outbox")).toBe("implementation-detail");
    expect(state("concept:struct/ab_tests")).toBe("code-only");
    expect(state("concept:struct/clients")).toBe("unmatched");
    expect(state("concept:route/POST /admin/reindex")).toBe("code-only");
    expect(state("concept:route/GET /health")).toBe("unmatched");
  });

  it("attaches behavior to the domain concept via route→entity (3 layers on Order)", async () => {
    const { unified } = await reconcile(scenario(), { now: NOW });
    const order = unified.concepts.find((c) => c.conceptId === "concept:order");
    expect(order?.intent).toBeTruthy();
    expect(order?.structure).toHaveLength(1);
    expect(order?.behavior).toHaveLength(1);
  });

  it("computes the Payment↛Shipping violation from topology + ADR", async () => {
    const { unified } = await reconcile(scenario(), { now: NOW });
    const payment = unified.concepts.find((c) => c.conceptId === "concept:payment");
    expect(payment?.divergences.some((d) => d.violates === "adr:0010")).toBe(true);
  });

  it("routes the genuinely-ambiguous entity to the manual queue", async () => {
    const { queue } = await reconcile(scenario(), { now: NOW });
    expect(queue.map((q) => q.entity)).toContain("clients");
    expect(queue.map((q) => q.entity)).not.toContain("accounts"); // adjudicated, not queued
  });

  it("burns a human decision into the registry so the next run doesn't re-ask", async () => {
    const first = await reconcile(scenario(), { now: NOW });
    expect(first.queue.map((q) => q.entity)).toContain("clients");

    // human says: clients IS Customer. Feed the prior registry back in.
    const second = await reconcile(
      { ...scenario(), prior: first.registry, decisions: [{ entityName: "clients", conceptId: "concept:customer" }] },
      { now: NOW },
    );
    expect(second.queue.map((q) => q.entity)).not.toContain("clients");
    const customer = second.unified.concepts.find((c) => c.conceptId === "concept:customer");
    expect(customer?.structure?.map((n) => n.nodeId)).toContain("structure:entity/clients");

    // third run WITHOUT the fresh decision — burn-in from the registry alone holds
    const third = await reconcile({ ...scenario(), prior: second.registry }, { now: NOW });
    expect(third.queue.map((q) => q.entity)).not.toContain("clients");
  });

  it("is deterministic given a fixed timestamp", async () => {
    const a = await reconcile(scenario(), { now: NOW });
    const b = await reconcile(scenario(), { now: NOW });
    expect(b.unified).toEqual(a.unified);
    expect(b.registry).toEqual(a.registry);
  });
});
