// packages/cli/src/commands/behavior-spawn.test.ts
//
// Unit tests for the behavior spawn sequence (run → [crud] → emit) and its crud
// gate. Uses an injected fake spawn so no real loop-e2e process is launched.

import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "@crawl-kit/behavior";
import { runBehaviorSpawns, shouldRunCrud, type BehaviorSpawn } from "./behavior-spawn.js";

/** Minimal WorkspaceConfig stub carrying only the fields shouldRunCrud reads. */
function makeConfig(over: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  const base = {
    databases: [{ name: "db", type: "postgres", host: "h", port: 5432, database: "d", user: "u", passwordEnv: "PW" }],
    launch: { seed: { command: "seed" } },
    targets: [{ name: "app", baseUrl: "http://localhost:3000", auth: { strategy: "form" } }],
  };
  return { ...base, ...over } as unknown as WorkspaceConfig;
}

/** Records the ordered `loop-e2e <sub>` invocations; always exits 0. */
function recordingSpawn(order: string[]): BehaviorSpawn {
  return async (_bin, args) => {
    order.push(args[0]!);
    return 0;
  };
}

describe("shouldRunCrud", () => {
  it("passes when databases + launch.seed + a form-auth target[0] are all present", () => {
    expect(shouldRunCrud(makeConfig())).toEqual({ ok: true });
  });

  it("fails (with reason) when there are no databases", () => {
    const gate = shouldRunCrud(makeConfig({ databases: [] as unknown as WorkspaceConfig["databases"] }));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBeTruthy();
  });

  it("fails when launch.seed is not configured", () => {
    const gate = shouldRunCrud(makeConfig({ launch: undefined }));
    expect(gate.ok).toBe(false);
  });

  it("fails when target[0] has no form auth (strategy none / missing)", () => {
    const none = shouldRunCrud(
      makeConfig({ targets: [{ name: "app", baseUrl: "http://localhost:3000", auth: { strategy: "none" } }] as unknown as WorkspaceConfig["targets"] }),
    );
    expect(none.ok).toBe(false);
    const missing = shouldRunCrud(
      makeConfig({ targets: [{ name: "app", baseUrl: "http://localhost:3000" }] as unknown as WorkspaceConfig["targets"] }),
    );
    expect(missing.ok).toBe(false);
  });
});

describe("runBehaviorSpawns", () => {
  it("(a) gate ON: invokes crud BETWEEN run and emit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-behsp-"));
    const order: string[] = [];
    const out = await runBehaviorSpawns("/bin/loop-e2e", root, { ok: true }, recordingSpawn(order));
    expect(out.ok).toBe(true);
    expect(order).toEqual(["run", "crud", "emit"]);
    expect(order.indexOf("crud")).toBeLessThan(order.indexOf("emit"));
  });

  it("(b) gate OFF: crud NOT invoked, run + emit still invoked", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-behsp-"));
    const order: string[] = [];
    const out = await runBehaviorSpawns("/bin/loop-e2e", root, { ok: false, reason: "databases 未設定" }, recordingSpawn(order));
    expect(out.ok).toBe(true);
    expect(order).toEqual(["run", "emit"]);
    expect(order).not.toContain("crud");
  });

  it("returns ok=false and stops when the crawl (run) fails, without crud/emit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-behsp-"));
    const order: string[] = [];
    const failingRun: BehaviorSpawn = async (_bin, args) => {
      order.push(args[0]!);
      return args[0] === "run" ? 1 : 0;
    };
    const out = await runBehaviorSpawns("/bin/loop-e2e", root, { ok: true }, failingRun);
    expect(out.ok).toBe(false);
    expect(order).toEqual(["run"]);
  });

  it("(c) stale-artifact guard: gate OFF removes a pre-existing *.crud-results.json before emit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-behsp-"));
    const runsDir = join(root, ".e2e", "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "prev.crud-results.json"), "[]\n", "utf8");

    // emit must not see the stale artifact: assert it's gone by the time emit spawns.
    let staleAtEmit: string[] = [];
    const spy: BehaviorSpawn = async (_bin, args) => {
      if (args[0] === "emit") staleAtEmit = (await readdir(runsDir)).filter((f) => f.endsWith(".crud-results.json"));
      return 0;
    };
    await runBehaviorSpawns("/bin/loop-e2e", root, { ok: false, reason: "databases 未設定" }, spy);
    expect(staleAtEmit).toEqual([]);
  });

  it("gate ON: leaves a pre-existing *.crud-results.json in place (crud regenerates it)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-behsp-"));
    const runsDir = join(root, ".e2e", "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "prev.crud-results.json"), "[]\n", "utf8");

    const order: string[] = [];
    await runBehaviorSpawns("/bin/loop-e2e", root, { ok: true }, recordingSpawn(order));
    const remaining = (await readdir(runsDir)).filter((f) => f.endsWith(".crud-results.json"));
    expect(remaining).toEqual(["prev.crud-results.json"]);
  });
});
