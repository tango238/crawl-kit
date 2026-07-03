// packages/structure/src/rdra/diagrams.ts
//
// ← rdra/*_diagram.py + mermaid_renderer.py. Renders the information model as
// Mermaid. Pure: model in, Mermaid string out. (The viewer renders the diff; these
// are the per-layer diagrams rdra used to ship, kept as an artifact of the port.)

import type { InformationModel } from "../information-model.js";

/** Mermaid `erDiagram` of the entity graph: attributes + FK relationships. */
export function entityRelationshipDiagram(model: InformationModel): string {
  const lines: string[] = ["erDiagram"];
  for (const e of model.entities.values()) {
    lines.push(`  ${e.name} {`);
    for (const attr of e.attributes) {
      lines.push(`    string ${attr}`);
    }
    lines.push("  }");
  }
  for (const e of model.entities.values()) {
    for (const target of e.dependsOn) {
      if (model.entities.has(target)) {
        lines.push(`  ${e.name} ||--o{ ${target} : "depends-on"`);
      }
    }
  }
  return lines.join("\n");
}

/** Mermaid `flowchart` of usecases → entities (with CRUD on the edge). */
export function usecaseDiagram(model: InformationModel): string {
  const lines: string[] = ["flowchart LR"];
  for (const [entity, usecases] of model.usecasesByEntity) {
    for (const uc of usecases) {
      const id = uc.name.replace(/[^A-Za-z0-9]/g, "_");
      lines.push(`  ${id}["${uc.name}"] -->|${uc.crud.join("")}| ${entity}`);
    }
  }
  return lines.join("\n");
}
