// packages/viewer/public/views/map-boundary.js
//
// 観測マップ menu: system boundary (/diff.json's DiffView, packages/viewer/src/diff-
// view.ts). Ports the old single-file viewer's (packages/viewer/index.html) diffView()
// System Boundary section (rTbl, the "broute"/"broute-detail" click-to-expand rows) —
// route: structure(declared) → behavior(observed) → persistence, with per-route
// input/persistence findings (packages/verification/src/boundary.ts's BoundaryFinding;
// not-persisted/roundtrip-ok/input-undeclared/input-missing/persistence-unobserved).
// The old page used a <tr class="broute"> + sibling hidden <tr> toggled by a delegated
// click handler; here each route is a <details> (same "<details> でよい" pattern as
// behavior-traffic.js's route rows) so no custom JS wiring is needed.
//
// Also renders d.findings (VerificationFinding[]) — adjudicated verification findings on
// the reconciled model. The old viewer computed these into DiffView's stats but never
// rendered them; this view adds that missing surface per the task brief ("verification/
// boundary findings が diff.json に含まれるなら該当部も").
//
// old block                                                     -> here
// ------------------------------------------------------------------
// diffView() rTbl (System Boundary route rows, click-to-expand)  -> boundaryRouteDetails() (<details> per route)
// diffView() rTbl's detail <ul> (per-route BoundaryFinding list)  -> findingList() inside each <details>
// (not rendered by the old viewer)                                -> verificationFindingsTable() (d.findings — new)

import { fetchJson, esc } from "/app.js";

const KIND_LABEL = {
  "input-undeclared": "入力: 宣言外の実行時入力",
  "input-missing": "入力: 宣言済みだが未観測",
  "not-persisted": "永続化: 保存されない（入れたのに残らない）",
  "persistence-unobserved": "永続化: 保存が未検証",
  "roundtrip-ok": "永続化: 保存を確認（roundtrip-ok）",
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || kind;
}

function sevBadge(severity) {
  return `<span class="sev-badge sev-${esc(severity)}">${esc(severity)}</span>`;
}

function obsBadge(on, label, title) {
  return `<span class="obs-badge ${on ? "obs-on" : "obs-off"}" title="${esc(title)}">${esc(label)}</span>`;
}

function findingList(findings) {
  if (!findings.length) return `<p class="empty-inline">この route の入力/永続化に関する指摘はありません。</p>`;
  const items = findings
    .map(
      (f) =>
        `<li class="${f.ok ? "layer-ok" : "layer-gap"}">${f.ok ? "✓" : "⚠"} ${sevBadge(f.severity)} <strong>${esc(
          kindLabel(f.kind),
        )}</strong> <span class="cell-ref">(${esc(f.facet)})</span><br>${esc(f.detail)}</li>`,
    )
    .join("");
  return `<ul class="boundary-finding-list">${items}</ul>`;
}

function eventsCell(events) {
  if (!events || events.length === 0) return `<span class="empty-inline">—</span>`;
  return events.map((e) => `<code>${esc(e)}</code>`).join(" ");
}

function boundaryRouteDetails(route, findingsByRoute) {
  const findings = findingsByRoute.get(route.route) || [];
  const verdict =
    route.problems > 0
      ? `<span class="layer-gap">⚠ ${esc(String(route.problems))}</span>`
      : route.ok > 0
        ? `<span class="layer-ok">✓ ${esc(String(route.ok))}</span>`
        : `<span class="empty-inline">—</span>`;
  return `
    <details class="route-details boundary-route">
      <summary>
        <span>${obsBadge(route.structure, "S", route.structure ? "structure で観測" : "structure 未観測")} ${obsBadge(
          route.behavior,
          "B",
          route.behavior ? "behavior で観測" : "behavior 未観測",
        )}</span>
        <span><code>${esc(route.route)}</code></span>
        <span>${esc(route.entity || "")}</span>
        <span>${verdict}</span>
      </summary>
      <div class="route-detail-body">
        <h4>route: structure（宣言）→ behavior（表示観測）→ persistence（永続化）</h4>
        <p class="muted-note">発火イベント: ${eventsCell(route.events)}</p>
        <h4>入力 / 永続化の指摘</h4>
        ${findingList(findings)}
      </div>
    </details>`;
}

function groupByRoute(boundaries) {
  const map = new Map();
  for (const f of boundaries) {
    if (!map.has(f.route)) map.set(f.route, []);
    map.get(f.route).push(f);
  }
  return map;
}

function classBadge(classification) {
  return `<span class="cls-badge cls-${esc(classification)}">${esc(classification)}</span>`;
}

function findingRow(f) {
  return `<tr>
    <td>${sevBadge(f.severity)}</td>
    <td>${classBadge(f.classification)}</td>
    <td>${esc(f.category)}</td>
    <td>${esc(f.expected)}</td>
    <td>${esc(f.actual)}</td>
    <td><code>${esc(f.location)}</code></td>
    <td>${esc(String(f.confidence))}</td>
  </tr>`;
}

function verificationFindingsTable(findings, stats) {
  if (!findings.length) return "";
  const statsLine = stats
    ? `<p class="muted-note">${esc(String(stats.total))} 件（bug ${esc(String(stats.bug))}・uncertain ${esc(
        String(stats.uncertain),
      )}・unnecessary ${esc(String(stats.unnecessary))}）</p>`
    : "";
  const rows = findings.map(findingRow).join("");
  return `
    <h3 class="section-title">検証所見（Verification Findings）</h3>
    ${statsLine}
    <table class="data-table">
      <thead><tr><th>severity</th><th>classification</th><th>category</th><th>expected</th><th>actual</th><th>location</th><th>confidence</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function legend() {
  return `
    <div class="diff-legend">
      <span class="legend-item"><span class="obs-badge obs-on">S/B</span>structure / behavior で観測</span>
      <span class="legend-item"><span class="legend-dot legend-ok"></span>ok（問題なし）</span>
      <span class="legend-item"><span class="legend-dot legend-gap"></span>問題あり</span>
      <span class="legend-item muted-note">「持続的でない」＝ not-persisted（入力を受けるが保存が観測されない）が最重要チェック。roundtrip-ok は保存を確認できた最良の状態です。</span>
    </div>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let diff;
  try {
    diff = await fetchJson("/diff.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">観測マップ（システム境界）の取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const boundaryRoutes = Array.isArray(diff && diff.boundaryRoutes) ? diff.boundaryRoutes : [];
  const boundaries = Array.isArray(diff && diff.boundaries) ? diff.boundaries : [];
  const findings = Array.isArray(diff && diff.findings) ? diff.findings : [];

  if (boundaryRoutes.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">観測マップ — システム境界</h2>
      <p class="empty">境界 route がありません。ダッシュボードの「メニュー状況」で verification フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const findingsByRoute = groupByRoute(boundaries);
  const stats = diff.stats && diff.stats.boundaries;
  const statsText = stats
    ? `<p class="muted-note">${esc(String(stats.total))} 件中 ${esc(String(stats.problems))} 件に問題（high ${esc(
        String(stats.high),
      )}）・ok ${esc(String(stats.ok))}</p>`
    : "";
  const rows = boundaryRoutes.map((r) => boundaryRouteDetails(r, findingsByRoute)).join("");

  el.innerHTML = `
    <h2 class="view-title">観測マップ — システム境界</h2>
    <p class="view-desc">structure のルート × behavior の実アクセス/表示の対応を、route ごとに input / persistence の検証結果とともに表示します。</p>
    ${legend()}
    ${statsText}
    <div class="traffic-table boundary-table">
      <div class="traffic-table-head boundary-table-head">
        <span>観測</span><span>route</span><span>entity</span><span>判定</span>
      </div>
      ${rows}
    </div>
    ${verificationFindingsTable(findings, diff.stats && diff.stats.findings)}
  `;
}
