// packages/viewer/src/view-model.ts
//
// Assembles the viewer's display contract — modelled on rdra-viewer's
// `rdra-view-model.json` (entities / relationships / usecases / uc_entity_crud /
// mermaid_sources) so the menu + tables match it — PLUS crawl-kit's own `reconcile`
// section (the 8-state diff), which rdra-viewer has no concept of.
//
// Pure read of the data/ directory; the viewer stays a dumb renderer.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_FILES, dataPath, resolveRoot } from "@crawl-kit/contract";

type Crud = "C" | "R" | "U" | "D";

interface RdraEntity {
  name: string;
  attributes: string[];
  dependsOn?: string[];
  dependedOnBy?: string[];
  crud?: Crud[];
  source?: string;
}
interface RdraUsecase {
  name: string;
  entity: string;
  /** all entities the usecase touches (1-to-many); falls back to [entity]. */
  entities?: string[];
  route?: string;
  crud: Crud[];
}
interface RdraModel {
  entities: RdraEntity[];
  usecases: RdraUsecase[];
  crud?: { gaps?: Array<{ entity: string; missing: Crud[] }> };
}

export interface ViewModel {
  schemaVersion: string;
  generated_at: string;
  project_name: string;
  stats: { entities: number; usecases: number; routes: number; reconciled: number };
  entities: Array<{ name: string; class_name: string; table_name: string; attributes: string[]; description: string; crud: Crud[]; dependsOn: string[]; dependedOnBy: string[]; missing: Crud[] }>;
  relationships: Array<{ from_entity: string; to_entity: string; relation_type: string; label: string }>;
  usecases: Array<{ id: string; name: string; actor: string; category: string; priority: string; related_routes: string[]; related_entities: string[]; crud: Crud[] }>;
  uc_entity_crud: Record<string, Record<string, Crud[]>>;
  routes: Array<{ route: string; state: string; behavior: number }>;
  reconcile: Array<{ conceptId: string; name: string; state: string; intent: boolean; structure: number; behavior: number; decisions: string[]; divergences: Array<{ edge: string; detail: string; violates?: string; adjudicatedBy?: string }> }>;
  mermaid_sources: Record<string, string>;
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function readTextOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

const crudOrder: Crud[] = ["C", "R", "U", "D"];

export async function buildViewModel(): Promise<ViewModel> {
  const dataDir = join(resolveRoot(), "data");
  const rdra = await readJsonOr<RdraModel>(join(dataDir, "structure.rdra.json"), { entities: [], usecases: [] });
  const unified = await readJsonOr<{ generatedAt?: string; concepts?: Array<Record<string, unknown>> }>(
    dataPath(DATA_FILES.unified),
    { concepts: [] },
  );
  const erMmd = await readTextOr(join(dataDir, "structure.er.mmd"), "");
  const ucMmd = await readTextOr(join(dataDir, "structure.usecases.mmd"), "");

  // ---- entities (+ CRUD gaps) -------------------------------------------
  const gapByEntity = new Map<string, Crud[]>();
  for (const g of rdra.crud?.gaps ?? []) gapByEntity.set(g.entity, g.missing);

  const entities = rdra.entities.map((e) => ({
    name: e.name,
    class_name: e.name,
    table_name: e.name,
    attributes: e.attributes ?? [],
    description: e.source ?? "",
    crud: e.crud ?? [],
    dependsOn: e.dependsOn ?? [],
    dependedOnBy: e.dependedOnBy ?? [],
    missing: gapByEntity.get(e.name) ?? [],
  }));

  // ---- relationships (from topology) ------------------------------------
  const relationships: ViewModel["relationships"] = [];
  for (const e of rdra.entities) {
    for (const dep of e.dependsOn ?? []) {
      relationships.push({ from_entity: e.name, to_entity: dep, relation_type: "1-N", label: "依存" });
    }
  }

  // ---- usecases (group the per-route records by name) -------------------
  const ucGroups = new Map<string, { routes: Set<string>; entities: Set<string>; crud: Set<Crud> }>();
  for (const uc of rdra.usecases) {
    const g = ucGroups.get(uc.name) ?? { routes: new Set(), entities: new Set(), crud: new Set<Crud>() };
    if (uc.route) g.routes.add(uc.route);
    for (const e of (uc.entities?.length ? uc.entities : [uc.entity])) if (e) g.entities.add(e);
    for (const c of uc.crud) g.crud.add(c);
    ucGroups.set(uc.name, g);
  }
  const usecases: ViewModel["usecases"] = [];
  const uc_entity_crud: Record<string, Record<string, Crud[]>> = {};
  let n = 0;
  for (const [name, g] of ucGroups) {
    const id = `UC-${String(++n).padStart(3, "0")}`;
    const crud = crudOrder.filter((c) => g.crud.has(c));
    usecases.push({
      id,
      name,
      actor: "（未設定）",
      category: "",
      priority: "medium",
      related_routes: [...g.routes],
      related_entities: [...g.entities],
      crud,
    });
    uc_entity_crud[id] = {};
    for (const ent of g.entities) uc_entity_crud[id]![ent] = crud;
  }

  // ---- routes + reconcile (from unified.json) ---------------------------
  const concepts = unified.concepts ?? [];
  const routes: ViewModel["routes"] = [];
  const reconcile: ViewModel["reconcile"] = [];
  for (const c of concepts) {
    const conceptId = String(c.conceptId);
    const structure = Array.isArray(c.structure) ? (c.structure as unknown[]).length : 0;
    const behavior = Array.isArray(c.behavior) ? (c.behavior as unknown[]).length : 0;
    reconcile.push({
      conceptId,
      name: String(c.canonicalName),
      state: String(c.state),
      intent: Boolean(c.intent),
      structure,
      behavior,
      decisions: ((c.decisions as Array<{ adrId?: string }>) ?? []).map((d) => d.adrId ?? "").filter(Boolean),
      divergences: (c.divergences as ViewModel["reconcile"][number]["divergences"]) ?? [],
    });
    if (conceptId.startsWith("concept:route/")) {
      routes.push({ route: String(c.canonicalName), state: String(c.state), behavior });
    }
  }

  return {
    schemaVersion: "1.0",
    generated_at: unified.generatedAt ?? "",
    project_name: process.env.PROJECT_NAME ?? "crawl-kit",
    stats: { entities: entities.length, usecases: usecases.length, routes: routes.length, reconciled: reconcile.length },
    entities,
    relationships,
    usecases,
    uc_entity_crud,
    routes,
    reconcile,
    mermaid_sources: { information_model: erMmd.trim(), usecase_diagram: ucMmd.trim() },
  };
}
