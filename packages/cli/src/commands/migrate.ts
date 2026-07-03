// crawl-kit migrate — adopt an existing per-repo layout (e2e.config.yaml +
// data/ at the repo root) as a workspace: the repo root BECOMES the workspace
// root, so data/ stays where it is and only the config moves under .crawl-kit/.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findWorkspaceRoot, workspaceConfigPath } from "@crawl-kit/contract";
import { WorkspaceConfigSchema } from "@crawl-kit/behavior";
import { readYamlFile, writeYamlFile } from "./yaml-io.js";

type LegacyConfig = { repositories?: Array<Record<string, unknown>> } & Record<string, unknown>;

export async function migrateLegacy(root: string): Promise<{ converted: boolean }> {
  if (findWorkspaceRoot(root) === root) return { converted: false };
  const legacyPath = join(root, "e2e.config.yaml");
  if (!existsSync(legacyPath)) {
    throw new Error(`${root} に e2e.config.yaml がありません — 移行対象ではありません`);
  }
  const legacy = await readYamlFile<LegacyConfig>(legacyPath);
  const legacyRepos = legacy.repositories ?? [];
  // `path: "."` only makes sense for the single-repo layout this command targets
  // (repo root becomes the workspace root). Multi-repo legacy configs must leave
  // path unset so `setup` clones each repo under its own directory.
  const repositories =
    legacyRepos.length === 1
      ? legacyRepos.map((r) => ({ ...r, path: "." }))
      : legacyRepos.map((r) => ({ ...r }));
  const converted = { ...legacy, repositories };

  const parsed = WorkspaceConfigSchema.safeParse(converted);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(
      `変換後の設定が workspace.yaml として不正です — レガシー設定 (${legacyPath}) は互換性がありません: ${issues}`,
    );
  }

  await writeYamlFile(workspaceConfigPath(root), parsed.data);
  return { converted: true };
}

export async function cmdMigrate(args: string[]): Promise<void> {
  const root = resolve(args.find((a) => !a.startsWith("-")) ?? process.cwd());
  const { converted } = await migrateLegacy(root);
  console.log(
    converted
      ? `migrated: ${workspaceConfigPath(root)} を作成しました（今後はこちらが正。e2e.config.yaml は残置）`
      : "既にワークスペースです — 何もしていません",
  );
}
