// packages/reconciler/src/ingest.ts
//
// Read a layer's emitted LayerNode[] from disk. The reconciler consumes these and
// never mutates them — it links them to concepts. A missing emit is a user error
// (you ran the reconciler before the layer emitted), so it fails loudly.

import { readFile } from "node:fs/promises";
import type { LayerNode } from "@crawl-kit/contract";

export async function ingestLayerNodes(path: string): Promise<LayerNode[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`missing layer emit "${path}" — did you run the layer's \`emit\` first?`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`"${path}" is not a LayerNode array`);
  }
  return parsed as LayerNode[];
}
