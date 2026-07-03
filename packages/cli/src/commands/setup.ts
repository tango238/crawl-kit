// crawl-kit setup [dir]
//
// Initializes a workspace: .crawl-kit/workspace.yaml, clones the configured
// repositories, then (Task 6) analyzes each repo into .crawl-kit/repos/<name>.yaml.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { workspaceConfigPath, repoConfigPath } from "@crawl-kit/contract";
import {
  WorkspaceConfigSchema,
  loadWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceRepository,
  type RepoSetup,
} from "@crawl-kit/behavior";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";
import { makeReadlinePrompter, type Prompter } from "./prompt.js";
import { analyzeRepoForSetup, writeRepoSetup } from "./repo-analysis.js";

export type CloneFn = (url: string, dest: string, branch?: string) => void;

export type SetupDeps = {
  prompter?: Prompter;
  clone?: CloneFn;
};

function gitClone(url: string, dest: string, branch?: string): void {
  const args = ["clone", ...(branch ? ["--branch", branch] : []), url, dest];
  const r = spawnSync("git", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`git clone failed for ${url}`);
}

/** Derive a repo name from its clone URL: last path segment minus ".git". */
export function repoNameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, "").split("/").pop() ?? "repo";
  return last.replace(/\.git$/, "");
}

// A raw string (not yaml.stringify) so we can ship commented-out examples —
// spec A step 5 asks for a targets/databases skeleton plus env-var guidance.
// Every commented line is "# " + valid YAML, so uncommenting a whole block
// (and filling in `repositories`) produces a WorkspaceConfigSchema-parseable file.
const WORKSPACE_TEMPLATE = `repositories: []

# targets:
#   - name: app
#     baseUrl: "http://localhost:3000"
#     auth:
#       strategy: form        # form | basic | none
#       loginPath: /login
#       usernameEnv: APP_USERNAME
#       passwordEnv: APP_PASSWORD

# databases:
#   - name: main
#     type: postgres          # postgres | mysql
#     host: localhost
#     port: 5432
#     database: app
#     user: app
#     passwordEnv: APP_DB_PASSWORD

# maxParallel: 3
# regenerateTtlSeconds: 86400
`;

export async function scaffoldWorkspace(root: string): Promise<void> {
  const cfg = workspaceConfigPath(root);
  if (existsSync(cfg)) return;
  await mkdir(dirname(cfg), { recursive: true });
  await writeFile(cfg, WORKSPACE_TEMPLATE, "utf8");
}

export async function collectRepositoriesInteractive(prompter: Prompter): Promise<WorkspaceRepository[]> {
  const repos: WorkspaceRepository[] = [];
  for (;;) {
    const url = await prompter(`repo #${repos.length + 1} の git URL（空 Enter で終了): `);
    if (!url) break;
    const name = repoNameFromUrl(url);
    const role = (await prompter("role [backend/frontend] (backend): ")) || "backend";
    const audience = (await prompter("audience [user/admin] (user): ")) || "user";
    repos.push({
      name,
      label: name,
      url,
      role: role === "frontend" ? "frontend" : "backend",
      audience: audience === "admin" ? "admin" : "user",
    });
  }
  return repos;
}

/** Clone every configured repo whose local path doesn't exist yet. Returns cloned names. */
export async function cloneMissingRepos(
  root: string,
  config: WorkspaceConfig,
  clone: CloneFn = gitClone,
): Promise<string[]> {
  const cloned: string[] = [];
  for (const repo of config.repositories) {
    const dest = join(root, repo.path ?? repo.name);
    if (existsSync(dest)) continue;
    clone(repo.url, dest, repo.branch);
    cloned.push(repo.name);
  }
  return cloned;
}

export async function cmdSetup(args: string[], deps: SetupDeps = {}): Promise<void> {
  const root = resolve(args.find((a) => !a.startsWith("-")) ?? process.cwd());
  // Only create (and later close) a real readline interface when the caller didn't
  // inject a prompter (tests inject a plain Prompter that needs no close()).
  const owned = deps.prompter ? null : makeReadlinePrompter();
  const prompter = deps.prompter ?? owned!.ask;

  try {
    await scaffoldWorkspace(root);
    const cfgPath = workspaceConfigPath(root);
    const raw = (await readYamlFile<{ repositories?: unknown[] } | null>(cfgPath)) ?? {};

    if (!raw.repositories || raw.repositories.length === 0) {
      console.log("workspace.yaml に repositories がありません。対話で登録します。");
      const repos = await collectRepositoriesInteractive(prompter);
      if (repos.length === 0) throw new Error("リポジトリが1つも登録されていません");
      await writeYamlFile(cfgPath, { ...raw, repositories: repos });
    }

    const config = WorkspaceConfigSchema.parse(await readYamlFile<unknown>(cfgPath));
    const cloned = await cloneMissingRepos(root, config, deps.clone);
    console.log(
      cloned.length
        ? `cloned: ${cloned.join(", ")}`
        : "すべてのリポジトリはクローン済みです",
    );
    console.log(`workspace: ${root}`);

    const { getProvider } = await import("@crawl-kit/structure");
    const provider = getProvider();
    for (const repo of config.repositories) {
      const repoPath = join(root, repo.path ?? repo.name);
      const existingPath = repoConfigPath(root, repo.name);
      const existing = existsSync(existingPath)
        ? await readYamlFile<Partial<RepoSetup>>(existingPath)
        : null;
      const setup = await analyzeRepoForSetup(repoPath, {
        prompter,
        existing,
        llm: provider?.analyzeCodebase ? { analyzeCodebase: (p, q) => provider.analyzeCodebase!(p, q) } : null,
      });
      await writeRepoSetup(root, repo.name, setup);
      console.log(`analyzed: ${repo.name} (framework=${setup.framework})`);
    }

    const { missingEnv } = await loadWorkspaceConfig(root);
    if (missingEnv.length > 0) {
      console.log(`\n未設定の環境変数: ${missingEnv.join(", ")}`);
      console.log("上記を .env または環境変数として設定してください。");
    }
  } finally {
    owned?.close();
  }
}
