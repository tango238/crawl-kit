// packages/viewer/public/views/dashboard.js
//
// Dashboard view (#/): pipeline phase progress (progress.json, via
// /api/dashboard.json) + guidance — which menus have data, and for the ones
// that don't, why and how to unblock them (see dashboard-model.ts).

import { fetchJson, esc } from "/app.js";

const PHASE_ORDER = ["intent", "structure", "behavior", "reconcile", "verify"];

const STATUS_LABELS = {
  pending: "未実行",
  running: "実行中",
  completed: "完了",
  blocked: "ブロック",
  failed: "失敗",
};

// guidance[].menu -> human label. Keys mirror dashboard-model.ts's buildGuidance().
const MENU_LABELS = {
  intent: "intent（イベント/集約/状態遷移）",
  structure: "structure（ルーティング/ユースケース/エンティティ/ER図/エンティティ×UC）",
  "behavior-traffic": "behavior（通信ログ）",
  "behavior-sitemap": "behavior（画面遷移）",
  observability: "観測マップ（イベント/状態遷移/システム境界）",
};

function phaseCard(name, phase) {
  const total = (phase.tasks && phase.tasks.total) || 0;
  const completed = (phase.tasks && phase.tasks.completed) || 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const blockedReason =
    phase.status === "blocked" && phase.blockedReason
      ? `<p class="blocked-reason">${esc(phase.blockedReason)}</p>`
      : "";
  return `
    <div class="phase-card">
      <div class="phase-card-head">
        <span class="phase-name">${esc(name)}</span>
        <span class="badge badge-${esc(phase.status)}">${esc(STATUS_LABELS[phase.status] || phase.status)}</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
      <div class="progress-label">${completed}/${total} タスク完了</div>
      ${blockedReason}
    </div>`;
}

function guidanceSection(guidance) {
  const items = Array.isArray(guidance) ? guidance : [];
  const pending = items.filter((g) => !g.ok);
  if (items.length > 0 && pending.length === 0) {
    return `<p class="guidance-all-ok">全メニュー対応済みです。</p>`;
  }
  if (pending.length === 0) {
    return `<p class="empty">ガイダンス情報がありません。</p>`;
  }
  const rows = pending
    .map(
      (g) => `
    <li class="guidance-item">
      <span class="guidance-menu">${esc(MENU_LABELS[g.menu] || g.menu)}</span>
      ${g.reason ? `<span class="guidance-reason">${esc(g.reason)}</span>` : ""}
      ${g.command ? `<code>${esc(g.command)}</code>` : ""}
    </li>`,
    )
    .join("");
  return `<ul class="guidance-list">${rows}</ul>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/api/dashboard.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">ダッシュボードの取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const progress = (model && model.progress) || { phases: {}, updatedAt: "" };
  const phases = progress.phases || {};
  const cards = PHASE_ORDER.filter((name) => phases[name])
    .map((name) => phaseCard(name, phases[name]))
    .join("");

  el.innerHTML = `
    <h2 class="view-title">ダッシュボード</h2>
    <p class="updated-at">最終更新: ${esc(progress.updatedAt || "-")}</p>
    <div class="phase-cards">${cards || '<p class="empty">進捗情報がありません。</p>'}</div>
    <h3 class="section-title">メニュー状況</h3>
    ${guidanceSection(model && model.guidance)}
  `;
}
