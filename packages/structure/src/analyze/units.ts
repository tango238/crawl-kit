// packages/structure/src/analyze/units.ts
//
// Task 1 of the incremental/distributed analyzer: enumerate the repo into small,
// independently-analyzable *units* and give each a content hash. A unit is a coherent
// slice of the codebase (a routes file, a controllers subdirectory, the models folder)
// that Pass1/2/3 can parse in isolation and cache by hash — the substrate for both
// fan-out (each unit analyzed concurrently) and diff (only dirty units re-analyzed).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hashContent } from "@crawl-kit/freshness";
import { detectFrameworks } from "./context/knowledge.js";

/** A repo file with its content, path is POSIX-relative to the repo root. */
export interface RepoFile {
  path: string;
  content: string;
}

/** An independently-analyzable slice of the repo. */
export interface Unit {
  /** stable id, e.g. "laravel:routes/web", "laravel:controllers/Admin", "generic:src". */
  id: string;
  /** coarse category: "routes" | "controllers" | "models" | "generic". */
  kind: string;
  /** framework this unit belongs to ("laravel", "generic", ...). */
  framework: string;
  /** repo-relative POSIX file paths that make up the unit. */
  files: string[];
  /** content hash over the unit's (path, fileHash) pairs — stable, order-insensitive. */
  hash: string;
}

/** Manifest filenames we read to detect the framework. */
const MANIFEST_NAMES = new Set([
  "composer.json", "Gemfile", "requirements.txt", "pyproject.toml", "pom.xml",
  "build.gradle", "build.gradle.kts", "package.json", "go.mod", "Cargo.toml",
  "mix.exs", "pubspec.yaml",
]);

const DEFAULT_IGNORE = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next", ".cache",
  "coverage", "vendor", "__pycache__", ".venv", "venv", "data",
]);
const DEFAULT_EXTS = [
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
  ".py", ".rb", ".java", ".kt", ".cs", ".go", ".php",
  ".vue", ".svelte", ".erb", ".html", ".sql", ".prisma",
];
const MAX_FILE_BYTES = 1024 * 1024;

export interface EnumerateDeps {
  /** injectable file lister (tests pass a fake; default walks the disk). */
  listFiles?: (root: string) => RepoFile[];
  /** override framework detection (tests / callers that already know the stack). */
  frameworks?: string[];
}

/**
 * Enumerate a repo into units. Detects framework(s) from manifests (unless overridden),
 * lists source files (unless a lister is injected), and groups + hashes them.
 */
export function enumerateUnits(repoPath: string, deps: EnumerateDeps = {}): Unit[] {
  const files = (deps.listFiles ?? walkRepo)(repoPath);
  const frameworks = deps.frameworks ?? detectFromFiles(files);
  return groupIntoUnits(files, frameworks);
}

/** Pure grouping: turn a flat file list + detected frameworks into hashed units. */
export function groupIntoUnits(files: RepoFile[], frameworks: string[]): Unit[] {
  const rule = frameworks.map((fw) => FRAMEWORK_RULES[fw]).find(Boolean);
  if (rule) return rule(files);
  return genericUnits(files);
}

// ── framework rules ──────────────────────────────────────────────────────────

type Rule = (files: RepoFile[]) => Unit[];

const FRAMEWORK_RULES: Record<string, Rule> = {
  laravel: laravelUnits,
};

/**
 * Laravel: routes/*.php → one unit per routes file; app/Http/Controllers/** grouped by
 * immediate subdirectory; app/Models/** grouped by immediate subdirectory. Files outside
 * these slices (views, config, migrations) are intentionally out of scope for now.
 */
function laravelUnits(files: RepoFile[]): Unit[] {
  const units: Unit[] = [];

  const routeFiles = files.filter((f) => /^routes\/[^/]+\.php$/.test(f.path));
  for (const rf of routeFiles) {
    const name = rf.path.replace(/^routes\//, "").replace(/\.php$/, "");
    units.push(makeUnit(`laravel:routes/${name}`, "routes", "laravel", [rf]));
  }

  units.push(
    ...bySubdir(files, "app/Http/Controllers/", "laravel:controllers", "controllers", "laravel"),
  );
  units.push(
    ...bySubdir(files, "app/Models/", "laravel:models", "models", "laravel"),
  );

  return units.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Group files under `prefix` by their immediate subdirectory. Files directly under the
 * prefix get `baseId`; files under `<prefix><sub>/...` get `<baseId>/<sub>`.
 */
function bySubdir(
  files: RepoFile[],
  prefix: string,
  baseId: string,
  kind: string,
  framework: string,
): Unit[] {
  const buckets = new Map<string, RepoFile[]>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const sub = slash === -1 ? "" : rest.slice(0, slash);
    const id = sub ? `${baseId}/${sub}` : baseId;
    const bucket = buckets.get(id) ?? [];
    bucket.push(f);
    buckets.set(id, bucket);
  }
  return [...buckets.entries()].map(([id, bucket]) =>
    makeUnit(id, kind, framework, bucket),
  );
}

/** Fallback: group by top-level directory, tagged as the "generic" framework. */
function genericUnits(files: RepoFile[]): Unit[] {
  const buckets = new Map<string, RepoFile[]>();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    const top = slash === -1 ? "." : f.path.slice(0, slash);
    const bucket = buckets.get(top) ?? [];
    bucket.push(f);
    buckets.set(top, bucket);
  }
  return [...buckets.entries()]
    .map(([top, bucket]) => makeUnit(`generic:${top}`, "generic", "generic", bucket))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ── helpers ──────────────────────────────────────────────────────────────────

function makeUnit(id: string, kind: string, framework: string, files: RepoFile[]): Unit {
  return { id, kind, framework, files: files.map((f) => f.path), hash: unitHash(files) };
}

/** Order-insensitive content hash: sort by path, hash each file, hash the joined pairs. */
function unitHash(files: RepoFile[]): string {
  const lines = files
    .map((f) => `${f.path}:${hashContent(f.content)}`)
    .sort();
  return hashContent(lines.join("\n"));
}

function detectFromFiles(files: RepoFile[]): string[] {
  const snippets: Record<string, string> = {};
  for (const f of files) {
    const name = f.path.includes("/") ? f.path.slice(f.path.lastIndexOf("/") + 1) : f.path;
    if (MANIFEST_NAMES.has(name) && snippets[name] === undefined) snippets[name] = f.content;
  }
  return detectFrameworks(snippets);
}

/** Default file lister: walk the disk collecting source files + manifests with content. */
function walkRepo(root: string): RepoFile[] {
  const out: RepoFile[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!DEFAULT_IGNORE.has(name) && !name.startsWith(".")) walk(full);
        continue;
      }
      const isSource = DEFAULT_EXTS.some((e) => name.endsWith(e));
      if (!isSource && !MANIFEST_NAMES.has(name)) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      out.push({ path: relative(root, full).split("\\").join("/"), content });
    }
  };
  walk(root);
  return out;
}
