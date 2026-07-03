// packages/contract/src/progress.ts
//
// The progress ledger (.crawl-kit/progress.json): which pipeline phases ran,
// how many tasks each planned/completed, and why a phase is blocked. The
// dashboard and the CLI both read this file, so it lives on the spine.
// All updaters are pure — they return new objects, never mutate.

import { z } from "zod";
import { readJsonFileOr, writeJsonAtomic } from "./io.js";

export const PHASE_NAMES = ["intent", "structure", "behavior", "reconcile", "verify"] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

const PhaseStatusSchema = z.enum(["pending", "running", "completed", "blocked", "failed"]);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

const PhaseProgressSchema = z.object({
  status: PhaseStatusSchema,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  blockedReason: z.string().optional(),
  tasks: z.object({ total: z.number().int().min(0), completed: z.number().int().min(0) }),
});
export type PhaseProgress = z.infer<typeof PhaseProgressSchema>;

const ProgressSchema = z.object({
  runId: z.string().min(1),
  phases: z.object({
    intent: PhaseProgressSchema,
    structure: PhaseProgressSchema,
    behavior: PhaseProgressSchema,
    reconcile: PhaseProgressSchema,
    verify: PhaseProgressSchema,
  }),
  updatedAt: z.string(),
});
export type Progress = z.infer<typeof ProgressSchema>;

const now = (given?: string): string => given ?? new Date().toISOString();

function freshPhase(): PhaseProgress {
  // A fresh object per phase — sharing one literal across all five phases meant an
  // accidental consumer mutation (e.g. `progress.phases.intent.tasks.total = 5`)
  // corrupted every phase at once.
  return { status: "pending", tasks: { total: 0, completed: 0 } };
}

export function emptyProgress(runId: string, at?: string): Progress {
  return {
    runId,
    phases: {
      intent: freshPhase(),
      structure: freshPhase(),
      behavior: freshPhase(),
      reconcile: freshPhase(),
      verify: freshPhase(),
    },
    updatedAt: now(at),
  };
}

function withPhase(p: Progress, phase: PhaseName, next: PhaseProgress, at?: string): Progress {
  return { ...p, phases: { ...p.phases, [phase]: next }, updatedAt: now(at) };
}

export function withPhaseStatus(
  p: Progress,
  phase: PhaseName,
  status: PhaseStatus,
  opts: { reason?: string; now?: string } = {},
): Progress {
  const at = now(opts.now);
  const prev = p.phases[phase];
  return withPhase(
    p,
    phase,
    {
      ...prev,
      status,
      ...(status === "running" ? { startedAt: at } : {}),
      ...(status === "completed" || status === "failed" ? { completedAt: at } : {}),
      ...(status === "blocked" && opts.reason !== undefined ? { blockedReason: opts.reason } : {}),
    },
    at,
  );
}

export function withTasksRegistered(p: Progress, phase: PhaseName, total: number, at?: string): Progress {
  const prev = p.phases[phase];
  return withPhase(p, phase, { ...prev, tasks: { total, completed: Math.min(prev.tasks.completed, total) } }, at);
}

export function withTaskCompleted(p: Progress, phase: PhaseName, count = 1, at?: string): Progress {
  const prev = p.phases[phase];
  const completed = Math.min(prev.tasks.total, prev.tasks.completed + count);
  return withPhase(p, phase, { ...prev, tasks: { ...prev.tasks, completed } }, at);
}

export async function readProgressOrEmpty(path: string, runId: string): Promise<Progress> {
  const raw = await readJsonFileOr<unknown>(path, null);
  if (raw === null) return emptyProgress(runId);
  return ProgressSchema.parse(raw);
}

export async function writeProgress(path: string, p: Progress): Promise<void> {
  ProgressSchema.parse(p);
  await writeJsonAtomic(path, p);
}
