// packages/structure/src/analyze/context/project-context.ts
//
// ← context/project_context.py. Reads CLAUDE.md / AGENTS.md / README.md plus manifest
// files and a directory snapshot of the target repo, and formats them into the context
// block injected into every extraction prompt. This is what makes the analysis
// language/framework-agnostic: the LLM is told how THIS repo is laid out before it goes
// looking for routes/models/controllers.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectAndLoad } from "./knowledge.js";

const CONTEXT_FILES = ["CLAUDE.md", "AGENTS.md", "README.md"] as const;

const MANIFEST_FILES: Record<string, string> = {
  "package.json": "Node.js / JavaScript / TypeScript",
  "composer.json": "PHP",
  "Cargo.toml": "Rust",
  "go.mod": "Go",
  Gemfile: "Ruby",
  "pyproject.toml": "Python",
  "requirements.txt": "Python",
  "pom.xml": "Java (Maven)",
  "build.gradle": "Java / Kotlin (Gradle)",
  "build.gradle.kts": "Kotlin (Gradle)",
  "mix.exs": "Elixir",
  "pubspec.yaml": "Dart / Flutter",
  "Package.swift": "Swift",
  "CMakeLists.txt": "C / C++",
  Makefile: "Make-based project",
  "deno.json": "Deno / TypeScript",
  "bun.lockb": "Bun / JavaScript / TypeScript",
};

const MAX_MANIFEST_BYTES = 2000;
const MAX_CONTEXT_DOC_BYTES = 10000;
const IGNORE = new Set([
  "node_modules", "vendor", ".git", "__pycache__", ".venv",
  "venv", "dist", "build", "target", ".next", ".cache",
]);

export interface ProjectContext {
  repoPath: string;
  repoName: string;
  contextDocs: Record<string, string>;
  detectedStacks: string[];
  manifestSnippets: Record<string, string>;
  directoryTree: string;
  detectedFrameworks: string[];
  frameworkKnowledge: string;
}

function clip(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    return `${content.slice(0, maxBytes)}\n...(truncated)`;
  }
  return content;
}

function readContextDocs(repoPath: string): Record<string, string> {
  const docs: Record<string, string> = {};
  for (const filename of CONTEXT_FILES) {
    const filePath = join(repoPath, filename);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      try {
        docs[filename] = clip(readFileSync(filePath, "utf8"), MAX_CONTEXT_DOC_BYTES);
      } catch {
        /* skip */
      }
    }
  }
  return docs;
}

function detectTechStacks(repoPath: string): { stacks: string[]; snippets: Record<string, string> } {
  const stacks: string[] = [];
  const snippets: Record<string, string> = {};
  for (const [filename, stackName] of Object.entries(MANIFEST_FILES)) {
    const filePath = join(repoPath, filename);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      stacks.push(`${stackName} (${filename})`);
      try {
        snippets[filename] = clip(readFileSync(filePath, "utf8"), MAX_MANIFEST_BYTES);
      } catch {
        /* skip */
      }
    }
  }
  return { stacks, snippets };
}

function dirTree(base: string, maxDepth: number, prefix = "", depth = 0): string {
  if (depth >= maxDepth) return "";
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return "";
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    let isDir = false;
    try {
      isDir = statSync(join(base, name)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (!IGNORE.has(name)) dirs.push(name);
    } else {
      files.push(name);
    }
  }
  dirs.sort();
  files.sort();
  const items = [...dirs, ...files].slice(0, 50);
  const lines: string[] = [];
  items.forEach((name, i) => {
    const last = i === items.length - 1;
    lines.push(`${prefix}${last ? "`-- " : "|-- "}${name}`);
    if (dirs.includes(name)) {
      const sub = dirTree(join(base, name), maxDepth, prefix + (last ? "    " : "|   "), depth + 1);
      if (sub) lines.push(sub);
    }
  });
  return lines.join("\n");
}

export function buildContext(repoPath: string): ProjectContext {
  const contextDocs = readContextDocs(repoPath);
  const { stacks, snippets } = detectTechStacks(repoPath);
  const { frameworks, knowledge } = detectAndLoad(snippets);
  const directoryTree = dirTree(repoPath, 3);
  return {
    repoPath,
    repoName: repoPath.replace(/\/+$/, "").split("/").pop() ?? repoPath,
    contextDocs,
    detectedStacks: stacks,
    manifestSnippets: snippets,
    directoryTree,
    detectedFrameworks: frameworks,
    frameworkKnowledge: knowledge,
  };
}

/** ← format_context_for_prompt. Same section order and headings as the original. */
export function formatContextForPrompt(contexts: ProjectContext[]): string {
  const parts: string[] = [];
  for (const ctx of contexts) {
    parts.push(`# リポジトリ: ${ctx.repoName}`);
    parts.push(`パス: ${ctx.repoPath}`);
    parts.push("");

    if (ctx.detectedStacks.length > 0) {
      parts.push("## 技術スタック");
      for (const stack of ctx.detectedStacks) parts.push(`- ${stack}`);
      parts.push("");
    }

    for (const docName of ["CLAUDE.md", "AGENTS.md"]) {
      if (ctx.contextDocs[docName]) {
        parts.push(`## ${docName} の内容`);
        parts.push(ctx.contextDocs[docName]!);
        parts.push("");
      }
    }

    if (ctx.contextDocs["README.md"] && !ctx.contextDocs["CLAUDE.md"]) {
      parts.push("## README.md の内容");
      parts.push(ctx.contextDocs["README.md"]!);
      parts.push("");
    }

    if (ctx.frameworkKnowledge) {
      parts.push(`## 検出されたフレームワーク: ${ctx.detectedFrameworks.join(", ")}`);
      parts.push("");
      parts.push(
        "以下はフレームワークの典型的なプロジェクト構成です。ルート・モデル・コントローラー等を探す際の参考にしてください。",
      );
      parts.push("");
      parts.push(ctx.frameworkKnowledge);
      parts.push("");
    }

    if (Object.keys(ctx.manifestSnippets).length > 0) {
      parts.push("## マニフェストファイル抜粋");
      for (const [fname, content] of Object.entries(ctx.manifestSnippets)) {
        parts.push(`### ${fname}`);
        parts.push("```");
        parts.push(content);
        parts.push("```");
      }
      parts.push("");
    }

    if (ctx.directoryTree) {
      parts.push("## ディレクトリ構造");
      parts.push("```");
      parts.push(ctx.directoryTree);
      parts.push("```");
      parts.push("");
    }
  }
  return parts.join("\n");
}
