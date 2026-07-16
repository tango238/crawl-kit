import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "./llm/provider.js";
import { parseUnit } from "./scoped-parser.js";
import type { Unit } from "./units.js";

const unit = (over: Partial<Unit> = {}): Unit => ({
  id: "laravel:routes/web",
  kind: "routes",
  framework: "laravel",
  files: ["routes/web.php"],
  hash: "h1",
  ...over,
});

/** A fake Claude-Code-style provider (has analyzeCodebase) returning canned text. */
const codeLlm = (reply: string): LlmProvider => ({
  providerName: "fake",
  modelName: "fake",
  completeSimple: vi.fn(async () => "SHOULD NOT BE CALLED"),
  analyzeCodebase: vi.fn(async () => reply),
});

/** A fake API-style provider (no analyzeCodebase). */
const apiLlm = (reply: string): LlmProvider => ({
  providerName: "fake-api",
  modelName: "fake",
  completeSimple: vi.fn(async () => reply),
});

describe("parseUnit — pass 1 (route inventory)", () => {
  it("parses routes from the LLM reply into a fragment", async () => {
    const llm = codeLlm(
      JSON.stringify({
        routes: [{ method: "get", path: "/users", controller: "UserController", action: "index" }],
      }),
    );
    const frag = await parseUnit(unit(), 1, { llm, repoPath: "/repo" });
    expect(frag.unitId).toBe("laravel:routes/web");
    expect(frag.hash).toBe("h1");
    expect(frag.pass).toBe(1);
    expect(frag.routes).toEqual([
      { method: "GET", path: "/users", controller: "UserController", action: "index", middleware: [], prefix: "" },
    ]);
    expect(llm.analyzeCodebase).toHaveBeenCalledOnce();
    expect(llm.completeSimple).not.toHaveBeenCalled();
  });

  it("tolerates a ```json fenced reply", async () => {
    const llm = codeLlm("here you go:\n```json\n{ \"routes\": [ { \"method\": \"POST\", \"path\": \"/x\" } ] }\n```\n");
    const frag = await parseUnit(unit(), 1, { llm, repoPath: "/repo" });
    expect(frag.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });
});

describe("parseUnit — pass 2 (detail)", () => {
  it("parses controllers, models and refs", async () => {
    const llm = codeLlm(
      JSON.stringify({
        controllers: [{ classNameRef: "UserController", filePath: "app/Http/Controllers/UserController.php", requestRules: { store: ["name:required"] } }],
        models: [{ className: "User", tableName: "users", fillable: ["name", "email"] }],
        refs: [{ from: "UserController", to: "User", kind: "controller->model" }],
      }),
    );
    const frag = await parseUnit(unit({ kind: "controllers", id: "laravel:controllers" }), 2, { llm, repoPath: "/repo" });
    expect(frag.pass).toBe(2);
    expect(frag.controllers[0].classNameRef).toBe("UserController");
    expect(frag.controllers[0].requestRules).toEqual({ store: ["name:required"] });
    expect(frag.controllers[0].methods).toEqual([]); // defaulted
    expect(frag.models[0].tableName).toBe("users");
    expect(frag.refs).toEqual([{ from: "UserController", to: "User", kind: "controller->model" }]);
  });
});

describe("parseUnit — pass 1 deterministic laravel route parsing", () => {
  // Silence the info/warn lines the deterministic path emits.
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterAll(() => vi.restoreAllMocks());

  const withRepo = (files: Record<string, string>): string => {
    const repo = mkdtempSync(join(tmpdir(), "ck-scoped-"));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(repo, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    return repo;
  };

  it("parses a laravel routes unit from disk WITHOUT calling the LLM", async () => {
    const repo = withRepo({
      "routes/web.php": `<?php
        Route::group(['prefix' => 'admin'], static function () {
          Route::get('/users', 'UserController@index');
          Route::post('/users', 'UserController@store');
        });
      `,
    });
    const llm = codeLlm("SHOULD NOT BE CALLED");
    const frag = await parseUnit(unit(), 1, { llm, repoPath: repo });
    expect(frag.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /admin/users", "POST /admin/users"]);
    expect(llm.analyzeCodebase).not.toHaveBeenCalled();
    expect(llm.completeSimple).not.toHaveBeenCalled();
  });

  it("works offline (llm null) for a routes unit that exists on disk", async () => {
    const repo = withRepo({ "routes/web.php": `<?php Route::get('/ping', 'C@ping');` });
    const frag = await parseUnit(unit(), 1, { llm: null, repoPath: repo });
    expect(frag.routes.map((r) => r.path)).toEqual(["/ping"]);
  });

  it("falls back to the LLM when deterministic parsing yields zero routes", async () => {
    const repo = withRepo({ "routes/web.php": `<?php // no routes here` });
    const llm = codeLlm(JSON.stringify({ routes: [{ method: "GET", path: "/from-llm" }] }));
    const frag = await parseUnit(unit(), 1, { llm, repoPath: repo });
    expect(frag.routes.map((r) => r.path)).toEqual(["/from-llm"]);
    expect(llm.analyzeCodebase).toHaveBeenCalledOnce();
  });

  it("does NOT use the deterministic path for non-routes laravel units", async () => {
    const llm = codeLlm(JSON.stringify({ routes: [{ method: "GET", path: "/x" }] }));
    await parseUnit(unit({ kind: "controllers", id: "laravel:controllers" }), 1, { llm, repoPath: "/repo" });
    expect(llm.analyzeCodebase).toHaveBeenCalledOnce();
  });

  it("does NOT use the deterministic path on pass 2", async () => {
    const repo = withRepo({ "routes/web.php": `<?php Route::get('/ping', 'C@ping');` });
    const llm = codeLlm(JSON.stringify({ controllers: [] }));
    await parseUnit(unit(), 2, { llm, repoPath: repo });
    expect(llm.analyzeCodebase).toHaveBeenCalledOnce();
  });
});

describe("parseUnit — backends & robustness", () => {
  it("uses completeSimple when analyzeCodebase is absent (API backend)", async () => {
    const llm = apiLlm(JSON.stringify({ routes: [{ method: "GET", path: "/a" }] }));
    const frag = await parseUnit(unit(), 1, { llm, repoPath: "/repo" });
    expect(frag.routes.map((r) => r.path)).toEqual(["/a"]);
    expect(llm.completeSimple).toHaveBeenCalledOnce();
  });

  it("returns an empty fragment when llm is null (offline)", async () => {
    const frag = await parseUnit(unit(), 1, { llm: null, repoPath: "/repo" });
    expect(frag).toEqual({ unitId: "laravel:routes/web", hash: "h1", pass: 1, routes: [], controllers: [], models: [], refs: [] });
  });

  it("returns an empty fragment (not throw) on unparseable output", async () => {
    const llm = codeLlm("I could not find any routes, sorry!");
    const frag = await parseUnit(unit(), 1, { llm, repoPath: "/repo" });
    expect(frag.routes).toEqual([]);
    expect(frag.pass).toBe(1);
  });

  it("does not throw when the model returns a non-array routes field", async () => {
    const llm = codeLlm(JSON.stringify({ routes: "oops" }));
    const frag = await parseUnit(unit(), 1, { llm, repoPath: "/repo" });
    expect(frag.routes).toEqual([]);
  });
});
