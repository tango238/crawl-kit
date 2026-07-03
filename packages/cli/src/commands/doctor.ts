// crawl-kit doctor — preflight checks. Each check knows which pipeline phase
// its failure blocks; `run` (P2) uses blockedPhases() to mark the ledger, and
// the dashboard explains "why is this menu empty" from the same data.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { findWorkspaceRoot } from "@crawl-kit/contract";
import { loadWorkspaceConfig, createDbAdapter } from "@crawl-kit/behavior";

export type BlockablePhase = "intent" | "structure" | "behavior";

export type DoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fixHint?: string;
  blocks: BlockablePhase | null;
};

export type DoctorDeps = {
  dbFactory?: typeof createDbAdapter;
  fetchFn?: typeof fetch;
  which?: (cmd: string) => boolean;
};

const DISTILL_URL = "https://github.com/tango238/distill-ddd";

function defaultWhich(cmd: string): boolean {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

/** Same truthiness rule as @crawl-kit/structure's getProvider — kept local so doctor
 *  doesn't take a dependency on structure just to answer "is a provider configured". */
function truthyEnv(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes"].includes(v.trim().toLowerCase());
}

/** LLM provider detected purely from env — mirrors structure's getProvider() gate
 *  without instantiating a real provider (doctor only needs a yes/no here). */
function hasLlmProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.USE_CLAUDE_CODE) || Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== "");
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

export async function runDoctor(startDir: string, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const which = deps.which ?? defaultWhich;
  const fetchFn = deps.fetchFn ?? fetch;
  const dbFactory = deps.dbFactory ?? createDbAdapter;

  const root = findWorkspaceRoot(startDir);
  if (!root) {
    return [
      {
        id: "workspace",
        label: "workspace",
        ok: false,
        detail: `${startDir} はワークスペース内ではありません`,
        fixHint: "crawl-kit setup <dir> でワークスペースを作成してください",
        blocks: null,
      },
    ];
  }

  const checks: DoctorCheck[] = [
    { id: "workspace", label: "workspace", ok: true, detail: root, blocks: null },
  ];

  let loaded: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  try {
    loaded = await loadWorkspaceConfig(root);
  } catch (error) {
    checks.push({
      id: "config",
      label: "workspace.yaml",
      ok: false,
      detail: (error as Error).message,
      blocks: null,
    });
    return checks;
  }
  const { config, secrets, missingEnv } = loaded;

  // P3: intent has THREE possible sources now — an already-produced
  // docs/domain/intent.json, the distill-ddd CLI, or an LLM provider (which
  // run's intentPhase uses to auto-draft one when the CLI/file aren't there).
  // So the CLI's absence should only block `intent` when NONE of the three is
  // available; otherwise a machine with intent.json checked in (e.g. CI, or a
  // teammate who ran /ddd locally) or with ANTHROPIC_API_KEY/USE_CLAUDE_CODE
  // set would have `run` permanently skip intent for no reason.
  const distillFound = which("distill-ddd");
  const intentJsonPath = join(root, "docs", "domain", "intent.json");
  const hasIntentJson = existsSync(intentJsonPath);
  const providerConfigured = hasLlmProvider();
  checks.push({
    id: "distill-ddd",
    label: "distill-ddd CLI",
    ok: distillFound || hasIntentJson || providerConfigured,
    detail: distillFound
      ? "found"
      : hasIntentJson
        ? "not found（docs/domain/intent.json を再利用）"
        : providerConfigured
          ? "not found（LLM プロバイダで自動ドラフト可）"
          : "not found（docs/domain/intent.json なし、LLM プロバイダも未設定）",
    fixHint: `インストール: ${DISTILL_URL} / または docs/domain/intent.json を用意 / または ANTHROPIC_API_KEY か USE_CLAUDE_CODE を設定`,
    blocks: "intent",
  });

  for (const repo of config.repositories) {
    const dir = join(root, repo.path ?? repo.name);
    const ok = existsSync(join(dir, ".git"));
    checks.push({
      id: `repo:${repo.name}`,
      label: `repo ${repo.name}`,
      ok,
      detail: ok ? dir : `${dir} が未クローン`,
      fixHint: "crawl-kit setup を実行してください",
      blocks: "structure",
    });
  }

  checks.push({
    id: "env",
    label: "env vars",
    ok: missingEnv.length === 0,
    detail: missingEnv.length === 0 ? "all resolved" : `missing: ${missingEnv.join(", ")}`,
    fixHint: ".env または環境変数を設定してください",
    blocks: "behavior",
  });

  for (const db of config.databases) {
    const password = secrets.db[db.passwordEnv];
    if (!password) {
      checks.push({
        id: `db:${db.name}`,
        label: `db ${db.name}`,
        ok: false,
        detail: `${db.passwordEnv} が未設定のため接続確認できません`,
        blocks: "behavior",
      });
      continue;
    }
    const adapter = dbFactory(db, password);
    try {
      await withTimeout(adapter.query("SELECT 1", []), 5000, `db ${db.name}`);
      checks.push({ id: `db:${db.name}`, label: `db ${db.name}`, ok: true, detail: `${db.host}:${db.port}/${db.database}`, blocks: "behavior" });
    } catch (error) {
      checks.push({
        id: `db:${db.name}`,
        label: `db ${db.name}`,
        ok: false,
        detail: (error as Error).message,
        fixHint: "DBを起動し接続情報を確認してください",
        blocks: "behavior",
      });
    } finally {
      await adapter.close().catch(() => {});
    }
  }

  for (const target of config.targets) {
    const auth = target.auth;
    if (auth && auth.strategy !== "none") {
      // A loginUrl/loginPath is only meaningful for form auth; basic auth needs
      // only the credentials themselves.
      const loginOk = auth.strategy === "form" ? Boolean(auth.loginUrl || auth.loginPath) : true;
      const credsOk = Boolean(auth.usernameEnv && auth.passwordEnv && secrets.targetAuth[auth.usernameEnv] && secrets.targetAuth[auth.passwordEnv]);
      checks.push({
        id: `login:${target.name}`,
        label: `login ${target.name}`,
        ok: loginOk && credsOk,
        detail: loginOk && credsOk ? "configured" : `loginUrl/loginPath=${loginOk}, credentials=${credsOk}`,
        fixHint: "workspace.yaml の auth と ID/Pass 環境変数を設定してください",
        blocks: "behavior",
      });
    }
    let reachable = true;
    let detail = target.baseUrl;
    try {
      await withTimeout(fetchFn(target.baseUrl, { method: "HEAD" }), 5000, `target ${target.name}`);
    } catch {
      try {
        await withTimeout(fetchFn(target.baseUrl), 5000, `target ${target.name}`);
      } catch (error) {
        reachable = false;
        detail = (error as Error).message;
      }
    }
    checks.push({
      id: `target:${target.name}`,
      label: `target ${target.name}`,
      ok: reachable,
      detail,
      fixHint: "対象アプリを起動してください（launch 設定があれば behavior init）",
      blocks: "behavior",
    });
  }

  const require = createRequire(import.meta.url);
  let playwrightOk = true;
  try {
    require.resolve("playwright", { paths: [root, import.meta.dirname ?? "."] });
  } catch {
    playwrightOk = false;
  }
  checks.push({
    id: "playwright",
    label: "playwright",
    ok: playwrightOk,
    detail: playwrightOk ? "resolvable" : "not installed",
    fixHint: "pnpm add -D playwright && npx playwright install chromium",
    blocks: "behavior",
  });

  return checks;
}

/** Phase → human-readable reason, from every failing blocking check. */
export function blockedPhases(checks: DoctorCheck[]): Map<BlockablePhase, string> {
  const map = new Map<BlockablePhase, string>();
  for (const c of checks) {
    if (c.ok || !c.blocks) continue;
    const prev = map.get(c.blocks);
    const entry = `${c.id}: ${c.detail}`;
    map.set(c.blocks, prev ? `${prev}; ${entry}` : entry);
  }
  return map;
}

export async function cmdDoctor(_args: string[]): Promise<void> {
  const checks = await runDoctor(process.cwd());
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    console.log(`${mark} ${c.label.padEnd(24)} ${c.detail}${!c.ok && c.fixHint ? `\n    → ${c.fixHint}` : ""}`);
  }
  const blocked = blockedPhases(checks);
  if (blocked.size > 0) {
    console.log("\nブロックされるフェーズ:");
    for (const [phase, reason] of blocked) console.log(`  ${phase}: ${reason}`);
    process.exitCode = 1;
  }
}
