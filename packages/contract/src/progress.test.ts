import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyProgress,
  readProgressOrEmpty,
  withPhaseStatus,
  withTaskCompleted,
  withTasksRegistered,
  writeProgress,
  PHASE_NAMES,
} from "./progress.js";

const T0 = "2026-07-03T00:00:00.000Z";
const T1 = "2026-07-03T00:01:00.000Z";

describe("progress ledger", () => {
  it("emptyProgress has all phases pending with 0/0 tasks", () => {
    const p = emptyProgress("run-1", T0);
    expect(PHASE_NAMES).toEqual(["intent", "structure", "behavior", "reconcile", "verify"]);
    for (const name of PHASE_NAMES) {
      expect(p.phases[name]).toEqual({ status: "pending", tasks: { total: 0, completed: 0 } });
    }
    expect(p.updatedAt).toBe(T0);
  });

  it("each phase is a distinct object — mutating one cannot corrupt the others", () => {
    const p = emptyProgress("run-1", T0);
    expect(p.phases.intent).not.toBe(p.phases.structure);
    (p.phases.intent.tasks as { total: number }).total = 99;
    expect(p.phases.structure.tasks.total).toBe(0);
    expect(p.phases.behavior.tasks.total).toBe(0);
    expect(p.phases.reconcile.tasks.total).toBe(0);
    expect(p.phases.verify.tasks.total).toBe(0);
  });

  it("withPhaseStatus is immutable and stamps timestamps", () => {
    const p0 = emptyProgress("run-1", T0);
    const p1 = withPhaseStatus(p0, "structure", "running", { now: T1 });
    expect(p0.phases.structure.status).toBe("pending"); // no mutation
    expect(p1.phases.structure.status).toBe("running");
    expect(p1.phases.structure.startedAt).toBe(T1);
    const p2 = withPhaseStatus(p1, "structure", "completed", { now: T1 });
    expect(p2.phases.structure.completedAt).toBe(T1);
  });

  it("blocked records the reason", () => {
    const p = withPhaseStatus(emptyProgress("r", T0), "behavior", "blocked", {
      reason: "DB接続失敗: ECONNREFUSED",
      now: T1,
    });
    expect(p.phases.behavior.blockedReason).toBe("DB接続失敗: ECONNREFUSED");
  });

  it("task counters register and complete, capped at total", () => {
    let p = withTasksRegistered(emptyProgress("r", T0), "structure", 3, T1);
    expect(p.phases.structure.tasks).toEqual({ total: 3, completed: 0 });
    p = withTaskCompleted(p, "structure", 2, T1);
    p = withTaskCompleted(p, "structure", 5, T1);
    expect(p.phases.structure.tasks).toEqual({ total: 3, completed: 3 });
  });

  it("roundtrips through disk and falls back to empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-prog-"));
    const path = join(dir, "progress.json");
    expect((await readProgressOrEmpty(path, "fresh")).runId).toBe("fresh");
    const p = withPhaseStatus(emptyProgress("r", T0), "intent", "running", { now: T1 });
    await writeProgress(path, p);
    expect(await readProgressOrEmpty(path, "ignored")).toEqual(p);
  });

  it("writeProgress rejects an invalid ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ck-prog-"));
    const bad = { runId: "r", phases: {}, updatedAt: T0 } as never;
    await expect(writeProgress(join(dir, "p.json"), bad)).rejects.toThrow();
  });
});
