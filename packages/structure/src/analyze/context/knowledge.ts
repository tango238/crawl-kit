// packages/structure/src/analyze/context/knowledge.ts
//
// ← context/knowledge/loader.py. Detect the framework(s) from manifest contents and
// load the matching knowledge sheet. The knowledge sheets tell the LLM where a given
// framework keeps its routes/models/controllers — the same per-framework hints the
// Python tool shipped, copied verbatim into packages/structure/knowledge/*.md.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src/analyze/context → ../../.. = package root; dist/analyze/context → same.
const KNOWLEDGE_DIR = join(here, "..", "..", "..", "knowledge");

// (manifest filename, search keyword, framework id) — order preserved from the original.
const DETECTION_RULES: ReadonlyArray<readonly [string, string, string]> = [
  ["composer.json", "laravel/framework", "laravel"],
  ["Gemfile", "rails", "rails"],
  ["requirements.txt", "django", "django"],
  ["pyproject.toml", "django", "django"],
  ["requirements.txt", "fastapi", "fastapi"],
  ["pyproject.toml", "fastapi", "fastapi"],
  ["pom.xml", "spring-boot", "spring_boot"],
  ["build.gradle", "spring-boot", "spring_boot"],
  ["build.gradle.kts", "spring-boot", "spring_boot"],
  ["package.json", '"next"', "nextjs"],
  ["package.json", '"nuxt"', "nuxt"],
  ["package.json", '"express"', "express"],
  ["go.mod", "gin-gonic/gin", "gin"],
  ["go.mod", "labstack/echo", "echo"],
  ["Cargo.toml", "actix-web", "actix"],
  ["mix.exs", "phoenix", "phoenix"],
  ["pubspec.yaml", "flutter", "flutter"],
];

export function detectFrameworks(manifestSnippets: Record<string, string>): string[] {
  const detected: string[] = [];
  const seen = new Set<string>();
  for (const [manifestFile, keyword, frameworkId] of DETECTION_RULES) {
    if (seen.has(frameworkId)) continue;
    const content = manifestSnippets[manifestFile] ?? "";
    if (content.toLowerCase().includes(keyword.toLowerCase())) {
      detected.push(frameworkId);
      seen.add(frameworkId);
    }
  }
  return detected;
}

export function loadKnowledge(frameworkIds: string[]): string {
  const parts: string[] = [];
  for (const id of frameworkIds) {
    const file = join(KNOWLEDGE_DIR, `${id}.md`);
    if (existsSync(file)) {
      try {
        parts.push(readFileSync(file, "utf8"));
      } catch {
        /* skip unreadable */
      }
    }
  }
  return parts.join("\n\n---\n\n");
}

export function detectAndLoad(
  manifestSnippets: Record<string, string>,
): { frameworks: string[]; knowledge: string } {
  const frameworks = detectFrameworks(manifestSnippets);
  return { frameworks, knowledge: loadKnowledge(frameworks) };
}
