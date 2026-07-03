import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { scaffoldWorkspace, cloneMissingRepos, collectRepositoriesInteractive, cmdSetup } from "./setup.js";
import { writeYamlFile } from "./yaml-io.js";
import { WorkspaceConfigSchema } from "@crawl-kit/behavior";

describe("setup", () => {
  it("scaffoldWorkspace creates .crawl-kit/workspace.yaml once (idempotent)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-setup-"));
    await scaffoldWorkspace(root);
    const cfg = join(root, ".crawl-kit", "workspace.yaml");
    expect(existsSync(cfg)).toBe(true);
    const first = await readFile(cfg, "utf8");
    await scaffoldWorkspace(root); // second run must not overwrite
    expect(await readFile(cfg, "utf8")).toBe(first);
  });

  it("cloneMissingRepos clones only repos whose path is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-clone-"));
    await mkdir(join(root, "frontend"), { recursive: true }); // already cloned
    const config = WorkspaceConfigSchema.parse({
      repositories: [
        { name: "backend", label: "BE", url: "https://example.com/be.git", role: "backend", audience: "user" },
        { name: "frontend", label: "FE", url: "https://example.com/fe.git", role: "frontend", audience: "user" },
      ],
    });
    const calls: Array<{ url: string; dest: string }> = [];
    const cloned = await cloneMissingRepos(root, config, (url, dest) => {
      calls.push({ url, dest });
    });
    expect(cloned).toEqual(["backend"]);
    expect(calls).toEqual([{ url: "https://example.com/be.git", dest: join(root, "backend") }]);
  });

  it("collectRepositoriesInteractive derives names from urls and stops on empty input", async () => {
    const answers = ["https://example.com/my-app.git", "", "", "", ""];
    // answers: url1, role(default backend), audience(default user), url2(empty → stop)
    const prompter = async () => answers.shift() ?? "";
    const repos = await collectRepositoriesInteractive(prompter);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ name: "my-app", role: "backend", audience: "user" });
  });

  it("scaffoldWorkspace writes a targets/databases skeleton with env-var guidance (spec A step 5)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-setup-tpl-"));
    await scaffoldWorkspace(root);
    const text = await readFile(join(root, ".crawl-kit", "workspace.yaml"), "utf8");
    expect(text).toContain("repositories: []");
    expect(text).toContain("# targets:");
    expect(text).toContain("usernameEnv");
    expect(text).toContain("passwordEnv");
    expect(text).toContain("# databases:");
    expect(text).toContain("maxParallel");
    expect(text).toContain("regenerateTtlSeconds");
  });

  it("the scaffold template parses under WorkspaceConfigSchema once uncommented", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-setup-tpl2-"));
    await scaffoldWorkspace(root);
    const text = await readFile(join(root, ".crawl-kit", "workspace.yaml"), "utf8");
    const uncommented = text
      .split("\n")
      .map((line) => (line.startsWith("# ") ? line.slice(2) : line === "#" ? "" : line))
      .join("\n")
      .replace(
        "repositories: []",
        'repositories:\n  - { name: be, label: BE, url: "https://example.com/be.git", role: backend, audience: user }',
      );
    expect(() => WorkspaceConfigSchema.parse(parse(uncommented))).not.toThrow();
  });
});

describe("cmdSetup", () => {
  it("resolves with a scripted (non-readline) prompter — critical regression: setup must not hang", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-cmdsetup-"));
    const answers = ["https://example.com/be.git", "", "", ""]; // url, role, audience, stop
    const prompter = async () => answers.shift() ?? "";
    await expect(cmdSetup([root], { prompter, clone: () => {} })).resolves.toBeUndefined();
  });

  it("does not call the prompter (and so never opens readline) when the workspace and repo setup are already fully configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-cmdsetup-full-"));
    await mkdir(join(root, "be"), { recursive: true }); // already cloned
    await writeYamlFile(join(root, ".crawl-kit", "workspace.yaml"), {
      repositories: [
        { name: "be", label: "BE", url: "https://example.com/be.git", role: "backend", audience: "user" },
      ],
    });
    await writeYamlFile(join(root, ".crawl-kit", "repos", "be.yaml"), {
      framework: "generic",
      structure: { summary: "s", routingDirs: [], controllerDirs: [], modelDirs: [] },
      devServer: { command: "npm run dev" },
      dbAccess: { source: ".env" },
      claudeMd: { present: false, source: "auto-analysis" },
    });
    // deps.prompter is intentionally omitted: cmdSetup falls back to the real lazy
    // readline prompter. process.stdin isn't a TTY under vitest, so if any prompt
    // were actually asked it would throw NonInteractiveError and this would reject.
    await expect(cmdSetup([root])).resolves.toBeUndefined();
  });
});
