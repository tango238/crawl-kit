// packages/verification/src/cli.ts
//
// `pnpm --filter @crawl-kit/verification run run`
// Reads the reconciled model (data/unified.json) and writes adjudicated Findings to
// data/verification.findings.json. The post-reconciliation Verification stage.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DATA_FILES, dataPath, readUnified, type LayerNode } from "@crawl-kit/contract";
import { buildReport } from "./verify.js";
import { buildBoundaryReport } from "./boundary.js";

async function ingestOrEmpty(path: string): Promise<LayerNode[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LayerNode[];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const unified = await readUnified(dataPath(DATA_FILES.unified));
  const now = new Date().toISOString();

  // concept-level findings (the reconciliation-aware checks)
  const report = buildReport(unified, now);
  const out = dataPath(DATA_FILES.verificationFindings);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  // boundary-level findings (the system-boundary axis: input/display/persistence).
  // Route-keyed join of the raw structure/behavior emits (ADR-0004 normalizeRoute).
  const [structureNodes, behaviorNodes] = await Promise.all([
    ingestOrEmpty(dataPath(DATA_FILES.structureNodes)),
    ingestOrEmpty(dataPath(DATA_FILES.behaviorNodes)),
  ]);
  const boundary = buildBoundaryReport(structureNodes, behaviorNodes, now);
  await writeFile(dataPath(DATA_FILES.boundaryFindings), `${JSON.stringify(boundary, null, 2)}\n`, "utf8");

  const s = report.summary;
  console.log(
    `verification: ${s.total} finding(s) [${s.bug} bug, ${s.uncertain} uncertain, ${s.unnecessary} unnecessary] → ${out}`,
  );
  const b = boundary.summary;
  console.log(
    `boundary: ${boundary.boundaries} boundary(ies), ${b.problems} problem(s) [${b.high} high], ${b.ok} ok → ${dataPath(DATA_FILES.boundaryFindings)}`,
  );
}

main().catch((error) => {
  console.error(`verification failed: ${(error as Error).message}`);
  process.exit(1);
});
