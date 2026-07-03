// packages/structure/src/corrections.ts
//
// The structure feedback overlay. A perfect static extraction in one pass is
// impossible — the LLM misses tables, mis-reads CRUD, mistakes a join table for an
// entity. So, exactly like the reconciler burns human decisions into the registry
// (ADR-0007), the structure layer burns human CORRECTIONS into an overlay that is
// re-applied on every run. You point out what's wrong once; it stays fixed forever,
// even after a full re-analysis replaces everything underneath it.
//
//   auto extract  ──apply(corrections)──▶  corrected extract  ──▶ emit / reconcile
//                         ▲
//                  data/structure.corrections.json   (durable, human-owned)

import type { Crud, EntityRecord, StructureExtract } from "./model.js";

export type Correction =
  | { kind: "set-crud"; entity: string; crud: Crud[]; note?: string }
  | { kind: "add-crud"; entity: string; crud: Crud[]; note?: string }
  | { kind: "add-entity"; entity: string; attributes?: string[]; dependsOn?: string[]; note?: string }
  | { kind: "remove-entity"; entity: string; note?: string }
  | { kind: "rename-entity"; from: string; to: string; note?: string }
  | { kind: "set-attributes"; entity: string; attributes: string[]; note?: string }
  | { kind: "add-attributes"; entity: string; attributes: string[]; note?: string }
  | { kind: "set-depends-on"; entity: string; dependsOn: string[]; note?: string };

export interface ApplyResult {
  extract: StructureExtract;
  /** entity names that a human correction touched — emit marks these as human-owned. */
  corrected: Set<string>;
  /** one line per correction, for the run log. */
  log: string[];
  /** corrections that referenced an unknown entity (skipped) — surfaced, not silent. */
  skipped: Array<{ correction: Correction; reason: string }>;
}

function findEntity(entities: EntityRecord[], name: string): number {
  return entities.findIndex((e) => e.name === name);
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Apply the corrections overlay to a freshly-extracted StructureExtract. Pure: returns
 * a new extract, never mutates the input. Order matters — corrections apply in sequence,
 * so a later one can refine an earlier one. Unknown-entity references are skipped and
 * reported (except add-entity, which creates).
 */
export function applyCorrections(extract: StructureExtract, corrections: Correction[]): ApplyResult {
  let entities: EntityRecord[] = extract.entities.map((e) => ({ ...e }));
  const crudOverrides: Record<string, Crud[]> = { ...(extract.crudOverrides ?? {}) };
  const corrected = new Set<string>();
  const log: string[] = [];
  const skipped: ApplyResult["skipped"] = [];

  const requireEntity = (c: Correction, name: string): boolean => {
    if (findEntity(entities, name) === -1) {
      skipped.push({ correction: c, reason: `unknown entity "${name}"` });
      return false;
    }
    return true;
  };

  for (const c of corrections) {
    switch (c.kind) {
      case "add-entity": {
        if (findEntity(entities, c.entity) !== -1) {
          skipped.push({ correction: c, reason: `entity "${c.entity}" already exists` });
          break;
        }
        entities.push({
          name: c.entity,
          attributes: c.attributes ?? [],
          ...(c.dependsOn ? { dependsOn: c.dependsOn } : {}),
          source: "human-correction",
        });
        corrected.add(c.entity);
        log.push(`+ entity "${c.entity}" (added by human)`);
        break;
      }
      case "remove-entity": {
        if (!requireEntity(c, c.entity)) break;
        entities = entities.filter((e) => e.name !== c.entity);
        delete crudOverrides[c.entity];
        log.push(`- entity "${c.entity}" (removed by human)`);
        break;
      }
      case "rename-entity": {
        const i = findEntity(entities, c.from);
        if (i === -1) { skipped.push({ correction: c, reason: `unknown entity "${c.from}"` }); break; }
        entities[i] = { ...entities[i]!, name: c.to };
        if (crudOverrides[c.from]) { crudOverrides[c.to] = crudOverrides[c.from]!; delete crudOverrides[c.from]; }
        // repoint dependsOn references
        entities = entities.map((e) => ({
          ...e,
          ...(e.dependsOn ? { dependsOn: e.dependsOn.map((d) => (d === c.from ? c.to : d)) } : {}),
        }));
        corrected.add(c.to);
        log.push(`~ entity "${c.from}" → "${c.to}"`);
        break;
      }
      case "set-attributes": {
        if (!requireEntity(c, c.entity)) break;
        const i = findEntity(entities, c.entity);
        entities[i] = { ...entities[i]!, attributes: uniq(c.attributes) };
        corrected.add(c.entity);
        log.push(`= attributes of "${c.entity}" set (${c.attributes.length})`);
        break;
      }
      case "add-attributes": {
        if (!requireEntity(c, c.entity)) break;
        const i = findEntity(entities, c.entity);
        entities[i] = { ...entities[i]!, attributes: uniq([...(entities[i]!.attributes ?? []), ...c.attributes]) };
        corrected.add(c.entity);
        log.push(`+ attributes of "${c.entity}" (${c.attributes.join(", ")})`);
        break;
      }
      case "set-depends-on": {
        if (!requireEntity(c, c.entity)) break;
        const i = findEntity(entities, c.entity);
        entities[i] = { ...entities[i]!, dependsOn: uniq(c.dependsOn) };
        corrected.add(c.entity);
        log.push(`= dependsOn of "${c.entity}" set (${c.dependsOn.join(", ")})`);
        break;
      }
      case "set-crud": {
        if (!requireEntity(c, c.entity)) break;
        crudOverrides[c.entity] = c.crud;
        corrected.add(c.entity);
        log.push(`= CRUD of "${c.entity}" set to [${c.crud.join("")}]`);
        break;
      }
      case "add-crud": {
        if (!requireEntity(c, c.entity)) break;
        const cur = crudOverrides[c.entity] ?? [];
        crudOverrides[c.entity] = uniq([...cur, ...c.crud]) as Crud[];
        corrected.add(c.entity);
        log.push(`+ CRUD of "${c.entity}" += [${c.crud.join("")}]`);
        break;
      }
    }
  }

  return {
    extract: { ...extract, entities, crudOverrides },
    corrected,
    log,
    skipped,
  };
}
