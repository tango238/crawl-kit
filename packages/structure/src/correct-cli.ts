// packages/structure/src/correct-cli.ts
//
// `pnpm --filter @crawl-kit/structure correct <kind> <args...>`
// Records a human correction into data/structure.corrections.json — the durable overlay
// re-applied on every emit/analyze. This is the feedback half: you point out what the
// auto-analysis got wrong, once, and it stays fixed across re-runs.
//
// Examples:
//   correct set-crud hotels CRUD
//   correct add-crud user_profiles U
//   correct add-entity rooms id,hotel_id,number hotels
//   correct set-attributes room_types id,name,capacity,price
//   correct rename-entity old_name new_name
//   correct remove-entity ab_tests
//   correct list
//   correct investigate /path/to/repo rooms "hint text"   (LLM proposes, then records)

import { dataPath, DATA_FILES } from "@crawl-kit/contract";
import { investigateEntity } from "./analyze/investigate.js";
import type { Correction } from "./corrections.js";
import type { Crud } from "./model.js";
import { loadCorrections, reportCorrections, saveCorrections } from "./outputs.js";
import { applyCorrections } from "./corrections.js";

const dataDir = dataPath(DATA_FILES.structureNodes).replace(/\/[^/]+$/, "");

function parseCrud(s: string): Crud[] {
  const letters = s.toUpperCase().replace(/[^CRUD]/g, "").split("");
  return (["C", "R", "U", "D"] as Crud[]).filter((c) => letters.includes(c));
}
function csv(s: string | undefined): string[] {
  return (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

async function append(corrections: Correction[]): Promise<void> {
  const existing = await loadCorrections(dataDir);
  await saveCorrections(dataDir, [...existing, ...corrections]);
  for (const c of corrections) console.log(`recorded: ${JSON.stringify(c)}`);
  console.log(`→ ${dataDir}/structure.corrections.json (再 emit/analyze で焼き込まれます)`);
}

function parseOne(argv: string[]): Correction | null {
  const [kind, a, b, c] = argv;
  switch (kind) {
    case "set-crud": return a && b ? { kind, entity: a, crud: parseCrud(b) } : null;
    case "add-crud": return a && b ? { kind, entity: a, crud: parseCrud(b) } : null;
    case "add-entity": return a ? { kind, entity: a, attributes: csv(b), ...(c ? { dependsOn: csv(c) } : {}) } : null;
    case "remove-entity": return a ? { kind, entity: a } : null;
    case "rename-entity": return a && b ? { kind, from: a, to: b } : null;
    case "set-attributes": return a && b ? { kind, entity: a, attributes: csv(b) } : null;
    case "add-attributes": return a && b ? { kind, entity: a, attributes: csv(b) } : null;
    case "set-depends-on": return a && b ? { kind, entity: a, dependsOn: csv(b) } : null;
    default: return null;
  }
}

async function main(): Promise<void> {
  const [kind, ...rest] = process.argv.slice(2);

  if (kind === "list") {
    const list = await loadCorrections(dataDir);
    console.log(`${list.length} correction(s) in ${dataDir}/structure.corrections.json:`);
    for (const c of list) console.log(`  ${JSON.stringify(c)}`);
    return;
  }

  if (kind === "investigate") {
    const [repo, entity, ...hint] = rest;
    if (!repo || !entity) { console.error("usage: correct investigate <repo> <entity> [hint]"); process.exit(2); }
    console.log(`investigating "${entity}" in ${repo} ...`);
    const result = await investigateEntity(repo, entity, hint.join(" ") || undefined);
    if (!result) {
      console.log("  no LLM backend (set USE_CLAUDE_CODE=true or ANTHROPIC_API_KEY), or nothing found.");
      return;
    }
    console.log(`  exists=${result.exists} attrs=${result.attributes.length} crud=[${result.crud.join("")}]`);
    result.evidence.slice(0, 4).forEach((e) => console.log(`  evidence: ${e}`));
    await append(result.proposed);
    return;
  }

  if (kind === "verify") {
    // dry-run: show what the current corrections do against the saved extract
    const list = await loadCorrections(dataDir);
    const { readFile } = await import("node:fs/promises");
    const nodes = JSON.parse(await readFile(dataPath(DATA_FILES.structureNodes), "utf8")) as Array<{ raw: { kind: string }; localName: string }>;
    const entities = nodes.filter((n) => n.raw.kind === "entity").map((n) => ({ name: n.localName, attributes: [] }));
    const applied = applyCorrections({ routes: [], entities, usecases: [] }, list);
    reportCorrections(applied);
    return;
  }

  const correction = parseOne(process.argv.slice(2));
  if (!correction) {
    console.error("usage: correct <set-crud|add-crud|add-entity|remove-entity|rename-entity|set-attributes|add-attributes|set-depends-on|investigate|list|verify> ...");
    process.exit(2);
  }
  await append([correction]);
}

main().catch((error) => {
  console.error(`correct failed: ${(error as Error).message}`);
  process.exit(1);
});
