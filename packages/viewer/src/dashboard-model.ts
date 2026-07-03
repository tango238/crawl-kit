// packages/viewer/src/dashboard-model.ts
//
// The dashboard's job: show which pipeline phase ran, and — when a menu has
// no data — WHY (missing artifact vs. blockedReason from progress.json). Split
// into an I/O wrapper (buildDashboardModel, reads progress.json + checks which
// artifacts exist) and a pure join (buildGuidance, the menu→artifact mapping),
// so the mapping logic is unit-testable without touching the filesystem.

import { existsSync } from "node:fs";
import {
  DATA_FILES,
  dataPath,
  progressPath,
  readProgressOrEmpty,
  resolveRoot,
  type PhaseName,
  type Progress,
} from "@crawl-kit/contract";

/** Presence of the key artifacts every menu depends on. */
export interface DashboardArtifacts {
  intentNodes: boolean;
  intentAggregates: boolean;
  structureRdra: boolean;
  unified: boolean;
  behaviorNodes: boolean;
  transactions: boolean;
  sitemap: boolean;
  mapping: boolean;
}

/** "Why is this menu empty" — one entry per viewer menu. */
export interface GuidanceItem {
  menu: string;
  ok: boolean;
  reason?: string;
  command?: string;
}

export interface DashboardModel {
  progress: Progress;
  artifacts: DashboardArtifacts;
  guidance: GuidanceItem[];
}

/** Fold progress.json's blockedReason for `phase` into a human-readable reason string. */
function withBlockedReason(base: string, progress: Progress, phase: PhaseName): string {
  const blockedReason = progress.phases[phase].blockedReason;
  return blockedReason ? `${base}（${blockedReason}）` : base;
}

/**
 * Pure menu→artifact mapping. No I/O — takes what buildDashboardModel already
 * read. Order of the returned array is the fixed menu order the dashboard renders.
 */
export function buildGuidance(artifacts: DashboardArtifacts, progress: Progress): GuidanceItem[] {
  const guidance: GuidanceItem[] = [];

  const intentOk = artifacts.intentNodes;
  guidance.push({
    menu: "intent",
    ok: intentOk,
    ...(intentOk ? {} : { reason: withBlockedReason("intent フェーズ未実行", progress, "intent") }),
    command: "crawl-kit run --only intent",
  });

  const structureOk = artifacts.structureRdra || artifacts.unified;
  guidance.push({
    menu: "structure",
    ok: structureOk,
    ...(structureOk ? {} : { reason: withBlockedReason("structure フェーズ未実行", progress, "structure") }),
    command: "crawl-kit run --only structure",
  });

  const trafficOk = artifacts.transactions && structureOk;
  guidance.push({
    menu: "behavior-traffic",
    ok: trafficOk,
    ...(trafficOk
      ? {}
      : {
          reason: withBlockedReason(
            !artifacts.transactions ? "behavior フェーズ未実行" : "structure のルーティングが未取得",
            progress,
            "behavior",
          ),
        }),
    command: "crawl-kit run --only behavior",
  });

  const sitemapOk = artifacts.sitemap;
  guidance.push({
    menu: "behavior-sitemap",
    ok: sitemapOk,
    ...(sitemapOk ? {} : { reason: withBlockedReason("behavior フェーズ未実行", progress, "behavior") }),
    command: "crawl-kit run --only behavior",
  });

  const observabilityOk = artifacts.unified && artifacts.intentNodes && artifacts.behaviorNodes;
  guidance.push({
    menu: "observability",
    ok: observabilityOk,
    ...(observabilityOk
      ? {}
      : { reason: withBlockedReason("reconcile 未実行、または各層の成果物が不足", progress, "reconcile") }),
    // reconcile has no --only entry (ONLY_PHASES is intent|structure|behavior — see run.ts) —
    // reconcile always runs as part of the full pipeline, so guide users to plain `crawl-kit run`.
    command: "crawl-kit run",
  });

  return guidance;
}

function checkArtifacts(root: string): DashboardArtifacts {
  return {
    intentNodes: existsSync(dataPath(DATA_FILES.intentNodes, root)),
    intentAggregates: existsSync(dataPath(DATA_FILES.intentAggregates, root)),
    structureRdra: existsSync(dataPath("structure.rdra.json", root)),
    unified: existsSync(dataPath(DATA_FILES.unified, root)),
    behaviorNodes: existsSync(dataPath(DATA_FILES.behaviorNodes, root)),
    transactions: existsSync(dataPath(DATA_FILES.behaviorTransactions, root)),
    sitemap: existsSync(dataPath(DATA_FILES.behaviorSitemap, root)),
    mapping: existsSync(dataPath(DATA_FILES.aggregateEntityMapping, root)),
  };
}

export async function buildDashboardModel(): Promise<DashboardModel> {
  const root = resolveRoot();
  const progress = await readProgressOrEmpty(progressPath(root), "viewer");
  const artifacts = checkArtifacts(root);
  const guidance = buildGuidance(artifacts, progress);
  return { progress, artifacts, guidance };
}
