// packages/intent/src/cli.ts
//
// `pnpm --filter @crawl-kit/intent emit`
// Reads a glossary (the demo fixture, or a path passed as argv[2]) and writes
// intent LayerNodes to data/intent.nodes.json.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_FILES, dataPath } from "@crawl-kit/contract";
import { emitIntentNodes } from "./emit.js";
import type { Glossary } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(here, "..", "fixtures", "sample.intent.json");

async function main(): Promise<void> {
  const inputPath = process.argv[2] ?? DEFAULT_FIXTURE;
  const glossary = JSON.parse(await readFile(inputPath, "utf8")) as Glossary;
  const nodes = emitIntentNodes(glossary, `intent-${process.pid}`);

  const out = dataPath(DATA_FILES.intentNodes);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

  const byKind = (prefix: string) =>
    nodes.filter((node) => node.nodeId.startsWith(prefix)).length;
  console.log(
    `intent: emitted ${byKind("intent:concept/")} concept, ` +
      `${byKind("intent:event/")} event, ` +
      `${byKind("intent:transition/")} transition node(s) → ${out}`,
  );
}

main().catch((error) => {
  console.error(`intent emit failed: ${(error as Error).message}`);
  process.exit(1);
});
