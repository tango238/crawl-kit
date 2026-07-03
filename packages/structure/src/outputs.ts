// packages/structure/src/outputs.ts
//
// Shared emit path for both `emit` (fixture) and `analyze` (live source): load the
// corrections overlay, apply it over the extract, emit nodes + RDRA artifacts, and
// write the four data/ files. Centralised so the corrections burn-in happens on EVERY
// path that produces structure output — there is no way to emit and skip corrections.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_FILES, dataPath } from "@crawl-kit/contract";
import { applyCorrections, type Correction, type ApplyResult } from "./corrections.js";
import { emitStructureNodes } from "./emit.js";
import { buildRdraArtifacts, type RdraArtifacts } from "./rdra/artifacts.js";
import type { StructureExtract } from "./model.js";

export const CORRECTIONS_FILE = "structure.corrections.json";

export async function loadCorrections(dir: string): Promise<Correction[]> {
  try {
    const text = await readFile(join(dir, CORRECTIONS_FILE), "utf8");
    const parsed = JSON.parse(text) as { corrections?: Correction[] } | Correction[];
    return Array.isArray(parsed) ? parsed : parsed.corrections ?? [];
  } catch {
    return [];
  }
}

export async function saveCorrections(dir: string, corrections: Correction[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, CORRECTIONS_FILE),
    `${JSON.stringify({ corrections }, null, 2)}\n`,
    "utf8",
  );
}

export interface WriteResult {
  applied: ApplyResult;
  rdra: RdraArtifacts;
  counts: { entities: number; routes: number; usecases: number; gaps: number };
}

/** Apply corrections, emit, and write all four structure output files. */
export async function writeStructureOutputs(
  extract: StructureExtract,
  runId: string,
): Promise<WriteResult> {
  const dir = dataPath(DATA_FILES.structureNodes).replace(/\/[^/]+$/, "");
  const corrections = await loadCorrections(dir);
  const applied = applyCorrections(extract, corrections);
  const corrected = applied.extract;

  const nodes = emitStructureNodes(corrected, runId, { corrected: applied.corrected });
  const rdra = buildRdraArtifacts(corrected);

  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(dataPath(DATA_FILES.structureNodes), `${JSON.stringify(nodes, null, 2)}\n`, "utf8"),
    writeFile(join(dir, "structure.rdra.json"), `${JSON.stringify(rdra.model, null, 2)}\n`, "utf8"),
    writeFile(join(dir, "structure.er.mmd"), `${rdra.diagrams.entityRelationship}\n`, "utf8"),
    writeFile(join(dir, "structure.usecases.mmd"), `${rdra.diagrams.usecases}\n`, "utf8"),
  ]);

  const routes = nodes.filter((n) => (n.raw as { kind?: string }).kind === "route").length;
  return {
    applied,
    rdra,
    counts: { entities: nodes.length - routes, routes, usecases: rdra.model.usecases.length, gaps: rdra.model.crud.gaps.length },
  };
}

/** Print the corrections that were applied (and any skipped), for the run log. */
export function reportCorrections(applied: ApplyResult): void {
  if (applied.log.length > 0) {
    console.log(`corrections applied (${applied.corrected.size} entit(y/ies)):`);
    for (const line of applied.log) console.log(`  ${line}`);
  }
  for (const s of applied.skipped) {
    console.log(`  [skip] ${s.reason}: ${JSON.stringify(s.correction)}`);
  }
}
