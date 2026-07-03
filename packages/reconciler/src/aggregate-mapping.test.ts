import { describe, expect, it } from "vitest";
import type { LayerNode, Unified, UnifiedConcept } from "@crawl-kit/contract";
import { deriveAggregateEntityMapping, type AggregateDocLike } from "./aggregate-mapping.js";

const entityNode = (name: string, opts: { repo?: string } = {}): LayerNode => ({
  nodeId: `structure:entity/${name}`,
  layer: "structure",
  localName: name,
  raw: { kind: "entity", attributes: [], dependsOn: [], crud: [] },
  source: { tool: "rdra-analyzer" },
  ...(opts.repo ? { repo: opts.repo } : {}),
});

const concept = (
  conceptId: string,
  canonicalName: string,
  structure: LayerNode[] = [],
): UnifiedConcept => ({
  conceptId,
  canonicalName,
  state: "aligned",
  ...(structure.length ? { structure } : {}),
  decisions: [],
  divergences: [],
});

const unifiedOf = (concepts: UnifiedConcept[]): Unified => ({
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  concepts,
});

describe("deriveAggregateEntityMapping", () => {
  it("assigns a high-confidence entity when the concept IS the aggregate root", () => {
    const node = entityNode("Order", { repo: "be" });
    const unified = unifiedOf([concept("concept:order", "Order", [node])]);
    const aggregates: AggregateDocLike = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
        },
      ],
    };

    const result = deriveAggregateEntityMapping(unified, aggregates, { now: "2026-07-03T00:00:00.000Z" });

    expect(result.generatedAt).toBe("2026-07-03T00:00:00.000Z");
    expect(result.unassigned).toEqual([]);
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0]).toMatchObject({ conceptId: "concept:order", name: "Order" });
    expect(result.aggregates[0].entities).toEqual([
      {
        nodeId: "structure:entity/Order",
        entity: "Order",
        repo: "be",
        confidence: 0.95,
        evidence: "reconciled to aggregate root",
      },
    ]);
  });

  it("assigns a mid-confidence entity when the concept is a member reached via dependsOn", () => {
    const node = entityNode("OrderLine");
    const unified = unifiedOf([concept("concept:order-line", "OrderLine", [node])]);
    const aggregates: AggregateDocLike = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          members: [
            { conceptId: "concept:order", name: "Order", via: "self" },
            { conceptId: "concept:order-line", name: "OrderLine", via: "dependsOn" },
          ],
        },
      ],
    };

    const result = deriveAggregateEntityMapping(unified, aggregates);

    expect(result.aggregates[0].entities).toEqual([
      {
        nodeId: "structure:entity/OrderLine",
        entity: "OrderLine",
        confidence: 0.85,
        evidence: "reconciled to member OrderLine",
      },
    ]);
    expect(result.unassigned).toEqual([]);
  });

  it("rescues an entity with no direct membership via slug name-similarity", () => {
    // "Orders" is not a member of the aggregate, but slugifies the same as
    // aggregate member "Order" → not exact; use containment case explicitly below.
    const node = entityNode("OrderArchive");
    const unified = unifiedOf([concept("concept:struct/order-archive", "OrderArchive", [node])]);
    const aggregates: AggregateDocLike = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
        },
      ],
    };

    const result = deriveAggregateEntityMapping(unified, aggregates);

    expect(result.aggregates[0].entities).toEqual([
      {
        nodeId: "structure:entity/OrderArchive",
        entity: "OrderArchive",
        confidence: 0.4,
        evidence: "partial name match",
      },
    ]);
    expect(result.unassigned).toEqual([]);
  });

  it("rescues an entity via exact slug equality against a member name", () => {
    const node = entityNode("payment_method");
    const unified = unifiedOf([concept("concept:struct/payment-method", "payment_method", [node])]);
    const aggregates: AggregateDocLike = {
      aggregates: [
        {
          conceptId: "concept:invoice",
          name: "Invoice",
          members: [
            { conceptId: "concept:invoice", name: "Invoice", via: "self" },
            { conceptId: "concept:payment-method-2", name: "Payment Method", via: "dependsOn" },
          ],
        },
      ],
    };

    const result = deriveAggregateEntityMapping(unified, aggregates);

    expect(result.aggregates[0].entities).toEqual([
      {
        nodeId: "structure:entity/payment_method",
        entity: "payment_method",
        confidence: 0.6,
        evidence: "name match",
      },
    ]);
    expect(result.unassigned).toEqual([]);
  });

  it("falls back to unassigned when there is no membership and no name similarity", () => {
    const node = entityNode("AuditLog");
    const unified = unifiedOf([concept("concept:struct/audit-log", "AuditLog", [node])]);
    const aggregates: AggregateDocLike = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
        },
      ],
    };

    const result = deriveAggregateEntityMapping(unified, aggregates);

    expect(result.aggregates[0].entities).toEqual([]);
    expect(result.unassigned).toEqual([{ nodeId: "structure:entity/AuditLog", entity: "AuditLog" }]);
  });

  it("carries repo through to unassigned entities when present", () => {
    const node = entityNode("AuditLog", { repo: "fe" });
    const unified = unifiedOf([concept("concept:struct/audit-log", "AuditLog", [node])]);
    const aggregates: AggregateDocLike = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
        },
      ],
    };

    const result = deriveAggregateEntityMapping(unified, aggregates);

    expect(result.unassigned).toEqual([{ nodeId: "structure:entity/AuditLog", entity: "AuditLog", repo: "fe" }]);
  });

  it("returns empty aggregates/unassigned for an empty unified", () => {
    const unified = unifiedOf([]);
    const aggregates: AggregateDocLike = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
        },
      ],
    };

    const result = deriveAggregateEntityMapping(unified, aggregates);

    expect(result.aggregates).toEqual([{ conceptId: "concept:order", name: "Order", entities: [] }]);
    expect(result.unassigned).toEqual([]);
  });

  it("ignores structure nodes that are not structure:entity/ prefixed", () => {
    const routeNode: LayerNode = {
      nodeId: "structure:route/GET /orders",
      layer: "structure",
      localName: "GET /orders",
      raw: { kind: "route" },
      source: { tool: "rdra-analyzer" },
    };
    const unified = unifiedOf([concept("concept:order", "Order", [routeNode])]);
    const aggregates: AggregateDocLike = {
      aggregates: [
        {
          conceptId: "concept:order",
          name: "Order",
          members: [{ conceptId: "concept:order", name: "Order", via: "self" }],
        },
      ],
    };

    const result = deriveAggregateEntityMapping(unified, aggregates);

    expect(result.aggregates[0].entities).toEqual([]);
    expect(result.unassigned).toEqual([]);
  });

  it("defaults generatedAt to an ISO now when opts.now is omitted", () => {
    const unified = unifiedOf([]);
    const aggregates: AggregateDocLike = { aggregates: [] };

    const result = deriveAggregateEntityMapping(unified, aggregates);

    expect(() => new Date(result.generatedAt).toISOString()).not.toThrow();
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
  });
});
