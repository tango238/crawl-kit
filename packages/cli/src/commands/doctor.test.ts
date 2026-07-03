import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor, blockedPhases } from "./doctor.js";

// The host env (or a prior test) may have USE_CLAUDE_CODE/ANTHROPIC_API_KEY set —
// scrub both around every test in this file so the "no LLM provider" checks below
// aren't accidentally satisfied by whatever's in the shell, and restore afterward.
let savedUseClaudeCode: string | undefined;
let savedAnthropicApiKey: string | undefined;

beforeEach(() => {
  savedUseClaudeCode = process.env["USE_CLAUDE_CODE"];
  savedAnthropicApiKey = process.env["ANTHROPIC_API_KEY"];
  delete process.env["USE_CLAUDE_CODE"];
  delete process.env["ANTHROPIC_API_KEY"];
});

afterEach(() => {
  if (savedUseClaudeCode === undefined) delete process.env["USE_CLAUDE_CODE"];
  else process.env["USE_CLAUDE_CODE"] = savedUseClaudeCode;
  if (savedAnthropicApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedAnthropicApiKey;
});

async function makeWorkspace(extraYaml = ""): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ck-doc-"));
  await mkdir(join(root, ".crawl-kit"), { recursive: true });
  await writeFile(
    join(root, ".crawl-kit", "workspace.yaml"),
    [
      "repositories:",
      '  - { name: be, label: BE, url: "https://example.com/be.git", role: backend, audience: user }',
      extraYaml,
    ].join("\n"),
    "utf8",
  );
  return root;
}

describe("runDoctor", () => {
  it("reports a single failing workspace check outside a workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-nodoc-"));
    const checks = await runDoctor(dir);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: "workspace", ok: false });
  });

  it("flags an uncloned repo as blocking structure", async () => {
    const root = await makeWorkspace();
    const checks = await runDoctor(root, { which: () => true, fetchFn: (async () => new Response()) as typeof fetch });
    const repoCheck = checks.find((c) => c.id === "repo:be")!;
    expect(repoCheck.ok).toBe(false);
    expect(repoCheck.blocks).toBe("structure");
  });

  it("db failure blocks behavior with the error in detail", async () => {
    process.env["CK_DOC_PW"] = "pw";
    const root = await makeWorkspace(
      [
        "databases:",
        "  - { name: main, type: postgres, host: localhost, port: 5432, database: app, user: app, passwordEnv: CK_DOC_PW }",
      ].join("\n"),
    );
    const failingDb = () => ({
      query: async () => {
        throw new Error("ECONNREFUSED");
      },
      close: async () => {},
    });
    const checks = await runDoctor(root, {
      which: () => true,
      fetchFn: (async () => new Response()) as typeof fetch,
      dbFactory: failingDb as never,
    });
    const db = checks.find((c) => c.id === "db:main")!;
    expect(db.ok).toBe(false);
    expect(db.detail).toContain("ECONNREFUSED");
    expect(blockedPhases(checks).get("behavior")).toContain("db:main");
    delete process.env["CK_DOC_PW"];
  });

  it("reports a failing config check (not a throw) for a malformed workspace.yaml", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-docbad-"));
    await mkdir(join(root, ".crawl-kit"), { recursive: true });
    // repositories: [] fails WorkspaceConfigSchema's min(1) — a raw ZodError previously escaped here.
    await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
    const checks = await runDoctor(root, { which: () => true, fetchFn: (async () => new Response()) as typeof fetch });
    expect(checks.find((c) => c.id === "workspace")).toMatchObject({ ok: true });
    const config = checks.find((c) => c.id === "config")!;
    expect(config).toBeDefined();
    expect(config.ok).toBe(false);
    expect(config.blocks).toBeNull();
  });

  it("distill-ddd missing blocks intent only", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, "be", ".git"), { recursive: true });
    const checks = await runDoctor(root, { which: () => false, fetchFn: (async () => new Response()) as typeof fetch });
    const ddd = checks.find((c) => c.id === "distill-ddd")!;
    expect(ddd.ok).toBe(false);
    expect(ddd.blocks).toBe("intent");
    expect(ddd.fixHint).toContain("github.com/tango238/distill-ddd");
    expect(blockedPhases(checks).has("structure")).toBe(false);
  });

  it("distill-ddd + intent.json + LLM provider all absent: blockedReason mentions LLM プロバイダ", async () => {
    // Regression: `run`'s preflight (blockedPhases) records THIS detail string as
    // the ledger's blockedReason for `intent` — run-phases.ts's own
    // NO_INTENT_SOURCE_REASON is unreachable in that path (doctor already skips
    // the phase body). So the doctor detail must carry the same guidance a
    // human/CI reading progress.json needs (mentions "LLM プロバイダ"), not just
    // a bare "not found".
    const root = await makeWorkspace();
    await mkdir(join(root, "be", ".git"), { recursive: true });
    const checks = await runDoctor(root, { which: () => false, fetchFn: (async () => new Response()) as typeof fetch });
    const ddd = checks.find((c) => c.id === "distill-ddd")!;
    expect(ddd.ok).toBe(false);
    expect(ddd.detail).toContain("LLM プロバイダ");
    const reason = blockedPhases(checks).get("intent");
    expect(reason).toContain("LLM プロバイダ");
  });

  it("distill-ddd missing does NOT block intent when an LLM provider is configured (env only)", async () => {
    // P3: run's intentPhase can auto-draft intent.json via an LLM provider when
    // neither distill-ddd nor an existing intent.json is present — doctor should
    // treat that as a valid intent source too, purely from env.
    const root = await makeWorkspace();
    await mkdir(join(root, "be", ".git"), { recursive: true });
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const checks = await runDoctor(root, { which: () => false, fetchFn: (async () => new Response()) as typeof fetch });
    const ddd = checks.find((c) => c.id === "distill-ddd")!;
    expect(ddd.ok).toBe(true);
    expect(ddd.detail).toContain("LLM プロバイダ");
    expect(blockedPhases(checks).has("intent")).toBe(false);
  });

  it("distill-ddd missing does NOT block intent when docs/domain/intent.json already exists", async () => {
    // P2's intent phase only reads an existing intent.json (distill-ddd auto-draft
    // is P3) — so a pre-supplied intent.json should let intent proceed even on a
    // machine without the distill-ddd CLI installed.
    const root = await makeWorkspace();
    await mkdir(join(root, "be", ".git"), { recursive: true });
    await mkdir(join(root, "docs", "domain"), { recursive: true });
    await writeFile(join(root, "docs", "domain", "intent.json"), '{"concepts": []}', "utf8");
    const checks = await runDoctor(root, { which: () => false, fetchFn: (async () => new Response()) as typeof fetch });
    const ddd = checks.find((c) => c.id === "distill-ddd")!;
    expect(ddd.ok).toBe(true);
    expect(ddd.detail).toContain("intent.json");
    expect(blockedPhases(checks).has("intent")).toBe(false);
  });
});
