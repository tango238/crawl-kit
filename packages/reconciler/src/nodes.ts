// packages/reconciler/src/nodes.ts
//
// Typed views over the free-form `raw` payloads each layer emits. The reconciler
// never mutates LayerNodes; these are read-only lenses so the match/classify code
// can talk about attributes and topology instead of `unknown`.

import type { LayerNode } from "@crawl-kit/contract";

export type Crud = "C" | "R" | "U" | "D";

export interface IntentConcept {
  node: LayerNode;
  conceptId: string;
  canonicalName: string;
  aliases: string[];
  kind?: string;
  attributes: string[];
  dependsOn: string[]; // concept names
}

export interface StructureEntity {
  node: LayerNode;
  name: string;
  attributes: string[];
  dependsOn: string[]; // entity names
  crud: Crud[];
}

export interface StructureRoute {
  node: LayerNode;
  routeKey: string;
  entity?: string; // entity name this route serves
}

function raw(node: LayerNode): Record<string, unknown> {
  return (node.raw ?? {}) as Record<string, unknown>;
}

/**
 * The intent layer now emits three node kinds (concepts, events, transitions);
 * only `intent:concept/...` nodes seed the registry. Events/transitions are the
 * mechanical diff axis, consumed elsewhere — not as concepts.
 */
export function isConceptNode(node: LayerNode): boolean {
  return node.layer === "intent" && node.nodeId.startsWith("intent:concept/");
}

export function asIntentConcept(node: LayerNode): IntentConcept {
  const r = raw(node);
  return {
    node,
    conceptId: String(r.conceptId),
    canonicalName: String(r.canonicalName ?? node.localName),
    aliases: (r.aliases as string[]) ?? [],
    kind: r.kind as string | undefined,
    attributes: (r.attributes as string[]) ?? [],
    dependsOn: (r.dependsOn as string[]) ?? [],
  };
}

export function isEntityNode(node: LayerNode): boolean {
  return node.layer === "structure" && raw(node).kind === "entity";
}

export function isRouteNode(node: LayerNode): boolean {
  return node.layer === "structure" && raw(node).kind === "route";
}

export function asStructureEntity(node: LayerNode): StructureEntity {
  const r = raw(node);
  return {
    node,
    name: node.localName,
    attributes: (r.attributes as string[]) ?? [],
    dependsOn: (r.dependsOn as string[]) ?? [],
    crud: (r.crud as Crud[]) ?? [],
  };
}

export function asStructureRoute(node: LayerNode): StructureRoute {
  const r = raw(node);
  return {
    node,
    routeKey: node.route ?? node.localName,
    entity: r.entity as string | undefined,
  };
}
