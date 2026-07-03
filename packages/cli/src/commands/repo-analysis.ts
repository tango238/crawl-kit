// Repo analysis for `crawl-kit setup`: figure out framework / structure /
// dev-server / db-access per repo. Heuristics first, LLM when available,
// the user as the last resort — and record where each answer came from.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { repoConfigPath } from "@crawl-kit/contract";
import { RepoSetupSchema, type RepoSetup } from "@crawl-kit/behavior";
import { detectFrameworks } from "@crawl-kit/structure";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { NonInteractiveError, type Prompter } from "./prompt.js";

export type AnalysisDeps = {
  prompter?: Prompter;
  llm?: { analyzeCodebase?(path: string, prompt: string): Promise<string> } | null;
  /** Previously written repos/<name>.yaml, if any. Fields already present here are
   *  not re-prompted for (setup re-runs must not re-ask questions the user already
   *  answered). */
  existing?: Partial<RepoSetup> | null;
};

/** Ask, but on a non-TTY prompter (see prompt.ts#NonInteractiveError) skip entirely
 *  and leave the field undefined instead of failing the whole `setup` run. */
async function askOrSkip(prompter: Prompter, question: string): Promise<string> {
  try {
    return await prompter(question);
  } catch (error) {
    if (error instanceof NonInteractiveError) return "";
    throw error;
  }
}

const MANIFESTS = ["package.json", "composer.json", "Gemfile", "go.mod", "pom.xml", "build.gradle", "Cargo.toml"];

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function detectFramework(repoPath: string): Promise<string> {
  const snippets: Record<string, string> = {};
  for (const m of MANIFESTS) {
    const text = await readIfExists(join(repoPath, m));
    if (text !== null) snippets[m] = text.slice(0, 4000);
  }
  const found = detectFrameworks(snippets);
  return found[0] ?? "generic";
}

async function detectDevServer(repoPath: string): Promise<RepoSetup["devServer"]> {
  const entries = await readdir(repoPath).catch(() => [] as string[]);
  const composeFile = entries.find((e) => /^docker-compose.*\.ya?ml$/.test(e));
  const pkg = await readIfExists(join(repoPath, "package.json"));
  if (pkg) {
    const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
    if (scripts["dev"]) return { command: "npm run dev", ...(composeFile ? { composeFile } : {}) };
  }
  if (existsSync(join(repoPath, "artisan"))) {
    return { command: "php artisan serve", ...(composeFile ? { composeFile } : {}) };
  }
  return composeFile ? { command: `docker compose -f ${composeFile} up`, composeFile } : undefined;
}

async function detectDbAccess(repoPath: string): Promise<RepoSetup["dbAccess"]> {
  const envExample = await readIfExists(join(repoPath, ".env.example"));
  if (envExample && /^DB_/m.test(envExample)) return { source: ".env", envFile: ".env" };
  return undefined;
}

export async function analyzeRepoForSetup(repoPath: string, deps: AnalysisDeps = {}): Promise<RepoSetup> {
  const prompter = deps.prompter ?? (async () => "");
  const existing = deps.existing ?? null;
  const claudeMdText = await readIfExists(join(repoPath, "CLAUDE.md"));

  const framework = await detectFramework(repoPath);
  let devServer = existing?.devServer ?? (await detectDevServer(repoPath));
  let dbAccess = existing?.dbAccess ?? (await detectDbAccess(repoPath));
  let summary = claudeMdText ? claudeMdText.slice(0, 4000) : "";

  if (!summary && deps.llm?.analyzeCodebase) {
    summary = (
      await deps.llm.analyzeCodebase(
        repoPath,
        "このリポジトリのルーティング定義・コントローラ・モデルがどのディレクトリにあるか3行で要約してください。",
      )
    ).trim();
  }

  let userAnswered = false;
  if (!devServer) {
    const answer = await askOrSkip(prompter, "開発環境の起動コマンドは?（例: npm run dev。空 Enter でスキップ): ");
    if (answer) {
      devServer = { command: answer };
      userAnswered = true;
    }
  }
  if (!dbAccess) {
    const answer = await askOrSkip(prompter, "DB接続情報の取得元は?（例: .env。空 Enter でスキップ): ");
    if (answer) {
      dbAccess = { source: answer };
      userAnswered = true;
    }
  }

  return RepoSetupSchema.parse({
    framework,
    structure: { summary, routingDirs: [], controllerDirs: [], modelDirs: [] },
    ...(devServer ? { devServer } : {}),
    ...(dbAccess ? { dbAccess } : {}),
    claudeMd: {
      present: claudeMdText !== null,
      source: claudeMdText !== null ? "claude-md" : userAnswered ? "user" : "auto-analysis",
    },
  });
}

/** Write repos/<name>.yaml. Existing values win — setup re-runs must not clobber
 *  human edits. */
export async function writeRepoSetup(root: string, name: string, setup: RepoSetup): Promise<void> {
  const path = repoConfigPath(root, name);
  const existing = existsSync(path) ? await readYamlFile<Partial<RepoSetup>>(path) : {};
  const merged = RepoSetupSchema.parse({ ...setup, ...existing });
  await writeYamlFile(path, merged);
}
