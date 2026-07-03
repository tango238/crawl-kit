// packages/reconciler/src/cli.ts
//
// `pnpm --filter @crawl-kit/reconciler run run`
// Ingests the intent + structure + behavior emits, the ADR seed, and the PRIOR
// registry (for burn-in), reconciles them, and writes data/registry.json (durable)
// and data/unified.json (derived) through the contract's validating atomic writers.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_FILES,
  dataPath,
  readRegistryOrEmpty,
  writeRegistry,
  writeUnified,
  type Adr,
} from "@crawl-kit/contract";
import { ingestLayerNodes } from "./ingest.js";
import { reconcile } from "./pipeline.js";
import type { HumanDecision } from "./queue.js";

const here = dirname(fileURLToPath(import.meta.url));
const ADR_FIXTURE = join(here, "..", "fixtures", "sample.adrs.json");

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function ingestOrEmpty(path: string) {
  try {
    return await ingestLayerNodes(path);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const [intent, structure, behavior] = await Promise.all([
    ingestOrEmpty(dataPath(DATA_FILES.intentNodes)),
    ingestLayerNodes(dataPath(DATA_FILES.structureNodes)),
    ingestLayerNodes(dataPath(DATA_FILES.behaviorNodes)),
  ]);

  const adrs = await readJsonOr<Adr[]>(process.env.ADRS_PATH ?? ADR_FIXTURE, []);
  const decisions = await readJsonOr<HumanDecision[]>(dataPath("decisions.json"), []);
  const prior = await readRegistryOrEmpty(dataPath(DATA_FILES.registry));

  const { registry, unified, queue } = await reconcile(
    { intent, structure, behavior, adrs, prior, decisions },
    { direction: (process.env.DIRECTION as "intent" | "code") ?? "intent" },
  );

  await writeRegistry(dataPath(DATA_FILES.registry), registry);
  await writeUnified(dataPath(DATA_FILES.unified), unified);

  const tally = unified.concepts.reduce<Record<string, number>>((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(tally)
    .sort()
    .map(([state, n]) => `${n} ${state}`)
    .join(", ");

  console.log(`reconciler: ${unified.concepts.length} concept(s) [${summary}] → ${dataPath(DATA_FILES.unified)}`);
  if (queue.length > 0) {
    console.log(`manual queue (${queue.length} ambiguous): ${queue.map((q) => `${q.entity}?→${q.bestConceptId} (${q.composite})`).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`reconcile failed: ${(error as Error).message}`);
  process.exit(1);
});
