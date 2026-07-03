import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRepoForSetup, writeRepoSetup } from "./repo-analysis.js";
import { NonInteractiveError } from "./prompt.js";

const noPrompt = async () => "";

describe("analyzeRepoForSetup", () => {
  it("detects a node repo with a dev script and compose file", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev" } }),
      "utf8",
    );
    await writeFile(join(repo, "docker-compose.yml"), "services: {}\n", "utf8");
    await writeFile(join(repo, ".env.example"), "DB_HOST=localhost\nDB_PORT=5432\n", "utf8");
    const setup = await analyzeRepoForSetup(repo, { prompter: noPrompt, llm: null });
    expect(setup.devServer?.command).toBe("npm run dev");
    expect(setup.devServer?.composeFile).toBe("docker-compose.yml");
    expect(setup.dbAccess).toEqual({ source: ".env", envFile: ".env" });
    expect(setup.claudeMd).toEqual({ present: false, source: "auto-analysis" });
  });

  it("prefers CLAUDE.md as the structure summary source", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    await writeFile(join(repo, "CLAUDE.md"), "# App\nRoutes live in src/routes.\n", "utf8");
    const setup = await analyzeRepoForSetup(repo, { prompter: noPrompt, llm: null });
    expect(setup.claudeMd).toEqual({ present: true, source: "claude-md" });
    expect(setup.structure.summary).toContain("Routes live in src/routes.");
  });

  it("asks the user when devServer is unknown and records their answer", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    const answers = ["make server", ""];
    const setup = await analyzeRepoForSetup(repo, {
      prompter: async () => answers.shift() ?? "",
      llm: null,
    });
    expect(setup.devServer?.command).toBe("make server");
    expect(setup.claudeMd.source).toBe("user");
  });

  it("uses the LLM summary when heuristics find nothing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    const setup = await analyzeRepoForSetup(repo, {
      prompter: noPrompt,
      llm: { analyzeCodebase: async () => "routes in app/, controllers in app/Http" },
    });
    expect(setup.structure.summary).toBe("routes in app/, controllers in app/Http");
  });

  it("re-run: skips prompting for fields already present in `existing`, and persists the answer for a still-missing field", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    const asked: string[] = [];
    const prompter = async (question: string) => {
      asked.push(question);
      return "psql -h db";
    };
    const setup = await analyzeRepoForSetup(repo, {
      prompter,
      llm: null,
      existing: { devServer: { command: "make dev" } },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("DB接続情報");
    expect(setup.devServer).toEqual({ command: "make dev" }); // unchanged, no prompt
    expect(setup.dbAccess).toEqual({ source: "psql -h db" }); // newly answered, persisted
  });

  it("non-TTY: skips devServer/dbAccess prompts entirely (leaves fields undefined) instead of throwing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ck-ra-"));
    const nonInteractivePrompter = async () => {
      throw new NonInteractiveError();
    };
    const setup = await analyzeRepoForSetup(repo, { prompter: nonInteractivePrompter, llm: null });
    expect(setup.devServer).toBeUndefined();
    expect(setup.dbAccess).toBeUndefined();
  });
});

describe("writeRepoSetup", () => {
  it("writes repos/<name>.yaml and keeps existing values on re-run", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-ra-ws-"));
    await writeRepoSetup(root, "be", {
      framework: "laravel",
      structure: { summary: "s1", routingDirs: [], controllerDirs: [], modelDirs: [] },
      devServer: { command: "php artisan serve" },
      claudeMd: { present: false, source: "auto-analysis" },
    });
    // second write with a different summary must NOT clobber the existing one
    await writeRepoSetup(root, "be", {
      framework: "generic",
      structure: { summary: "s2", routingDirs: [], controllerDirs: [], modelDirs: [] },
      claudeMd: { present: false, source: "auto-analysis" },
    });
    const text = await readFile(join(root, ".crawl-kit", "repos", "be.yaml"), "utf8");
    expect(text).toContain("s1");
    expect(text).toContain("laravel");
  });
});
