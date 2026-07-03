// packages/structure/src/cli.ts
//
// `pnpm --filter @crawl-kit/structure emit`
// Reads a static extract (the demo fixture, or a path passed as argv[2]), applies the
// corrections overlay, and writes data/structure.{nodes,rdra}.json + *.mmd.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StructureExtract } from "./model.js";
import { reportCorrections, writeStructureOutputs } from "./outputs.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = join(here, "..", "fixtures", "sample.structure.json");

async function main(): Promise<void> {
  const inputPath = process.argv[2] ?? DEFAULT_FIXTURE;
  const extract = JSON.parse(await readFile(inputPath, "utf8")) as StructureExtract;

  const { applied, counts } = await writeStructureOutputs(extract, `structure-${process.pid}`);
  reportCorrections(applied);
  console.log(
    `structure: ${counts.entities} entities, ${counts.routes} routes, ${counts.usecases} usecases, ${counts.gaps} CRUD gap(s)`,
  );
}

main().catch((error) => {
  console.error(`structure emit failed: ${(error as Error).message}`);
  process.exit(1);
});
