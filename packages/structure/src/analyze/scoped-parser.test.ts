import { describe, expect, it, vi } from "vitest";
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
