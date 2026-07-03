// packages/structure/src/emit.ts
//
// The boundary of the structure layer: turn the static model into contract
// LayerNodes. Two kinds:
//   - route nodes  → the strong key for the structure↔behavior edge. Anchored to
//                    their entity (via usecases) so behavior can reach the domain.
//   - entity nodes → carry attributes + topology, the strong signals for the
//                    intent↔structure edge (matched in the reconciler at M3).
//
// This is the structure-side replacement for loop-e2e's old `rdra-export`: emit
// onto the shared spine, let the reconciler do every join.

import type { LayerNode } from "@crawl-kit/contract";
import { buildCrudIndex } from "./crud.js";
import { buildInformationModel, type InformationModel } from "./information-model.js";
import type { Crud, StructureExtract } from "./model.js";

const TOOL = "rdra-analyzer" as const;

function source(runId?: string): LayerNode["source"] {
  return { tool: TOOL, ...(runId ? { runId } : {}) };
}

/** kebab slug; same convention the intent layer uses, so joins line up. */
function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function routeNodes(extract: StructureExtract, model: InformationModel, runId?: string): LayerNode[] {
  return extract.routes.map((r) => {
    const key = `${r.method.toUpperCase()} ${r.path}`;
    const anchor = model.routeToEntity.get(key);
    return {
      nodeId: `structure:route/${key}`,
      layer: "structure" as const,
      localName: key,
      raw: { kind: "route", ...r, entity: anchor?.entity, crud: anchor?.crud },
      route: key,
      source: source(runId),
    };
  });
}

function entityNodes(
  model: InformationModel,
  crudIndex: Map<string, Crud[]>,
  corrected: Set<string>,
  runId?: string,
): LayerNode[] {
  return [...model.entities.values()].map((e) => ({
    nodeId: `structure:entity/${e.name}`,
    layer: "structure" as const,
    localName: e.name,
    raw: {
      kind: "entity",
      attributes: e.attributes,
      dependsOn: e.dependsOn,
      crud: crudIndex.get(e.name) ?? [],
      ...(corrected.has(e.name) ? { corrected: true } : {}),
    },
    source: source(runId),
  }));
}

function eventNodes(extract: StructureExtract, runId?: string): LayerNode[] {
  return (extract.events ?? []).map((e) => ({
    nodeId: `structure:event/${slug(e.name)}`,
    layer: "structure" as const,
    localName: e.name,
    raw: {
      kind: "event",
      eventName: e.name,
      aggregate: e.aggregate ?? null,
      aggregateConceptId: e.aggregate ? `concept:${slug(e.aggregate)}` : null,
      trigger: e.trigger ?? null,
      properties: e.properties ?? [],
      ...(e.source ? { provenance: e.source } : {}),
    },
    source: source(runId),
  }));
}

function transitionNodes(extract: StructureExtract, runId?: string): LayerNode[] {
  return (extract.stateTransitions ?? []).map((t) => {
    const agg = t.aggregate ? slug(t.aggregate) : "unknown";
    const from = t.from ? slug(t.from) : "any"; // static analysis rarely knows the source state
    const to = slug(t.to) || "state";
    return {
      nodeId: `structure:transition/${agg}/${from}--${to}`,
      layer: "structure" as const,
      localName: `${t.aggregate ?? "?"}: ${t.from ?? "?"} → ${t.to}`,
      raw: {
        kind: "transition",
        aggregate: t.aggregate ?? null,
        aggregateConceptId: t.aggregate ? `concept:${slug(t.aggregate)}` : null,
        from: t.from ?? null,
        to: t.to,
        trigger: t.trigger ?? null,
        event: t.event ?? null,
        ...(t.source ? { provenance: t.source } : {}),
      },
      source: source(runId),
    };
  });
}

export interface EmitOptions {
  /** entity names a human correction touched — marked `corrected: true` on the node. */
  corrected?: Set<string>;
}

/** Emit all structure LayerNodes (routes + entities + events + transitions). */
export function emitStructureNodes(
  extract: StructureExtract,
  runId?: string,
  opts: EmitOptions = {},
): LayerNode[] {
  const model = buildInformationModel(extract);
  const crudIndex = buildCrudIndex(extract);
  const corrected = opts.corrected ?? new Set<string>();
  return [
    ...routeNodes(extract, model, runId),
    ...entityNodes(model, crudIndex, corrected, runId),
    ...eventNodes(extract, runId),
    ...transitionNodes(extract, runId),
  ];
}
