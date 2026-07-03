// packages/viewer/public/views/map-events.js
//
// 観測マップ menu: events (/diff.json's DiffView, packages/viewer/src/diff-view.ts).
// Ports the old single-file viewer's (packages/viewer/index.html) diffView() event
// section — intent axis, structure side-by-side (diffRows(d.events)) — MERGED with its
// "Event × route" table (the er/erTbl block) so behavior lands as a real 3rd column
// instead of a separate table below. behavior is NOT a direct event observation: it's
// derived by reverse lookup through the event's emitting routes — an event counts as
// "observed" when one of the routes that emits it (structure's route→event trace) was
// itself exercised at runtime. That inference is called out in the legend and per-cell,
// same as the old viewer's "◇ route 経由" / "⚠ not observed" wording.
//
// The event→route join is done server-side (diff-view.ts DiffRow.routes, mirroring
// traffic-model.ts's joinTrafficRoutes): each event row already carries its resolved
// EventRouteRow[], so this view reads `row.routes` directly and never re-normalizes.
//
// old block            -> here
// ------------------------------------------------------------------
// diffView() evTbl (intent/structure, diffRows(d.events))      -> eventRow()'s intent/structure <td>s
// diffView() erTbl (Event×route: intent/structure/behavior)    -> eventRow()'s behavior <td> (routeList)
// diffView() cBlock, events half (d.candidates.events)          -> candidateList(events) (map-shared.js)

import { fetchJson, esc } from "/app.js";
import { layerCell, labelCell, statsLine, candidateList } from "/views/map-shared.js";

function behaviorCell(rows) {
  const withRoute = rows.filter((r) => r.route);
  const anyObserved = rows.some((r) => r.behavior && r.behavior.observed);
  const summary = anyObserved
    ? `<span class="layer-ok">◇ route 経由で観測</span>`
    : `<span class="layer-gap">⚠ not observed</span>`;
  const items = withRoute
    .map((r) => {
      const ok = !!(r.behavior && r.behavior.observed);
      return `<li class="${ok ? "layer-ok" : "layer-gap"}">${ok ? "◇" : "⚠"} <code>${esc(r.route)}</code></li>`;
    })
    .join("");
  return `<td class="layer-cell ${anyObserved ? "layer-ok" : "layer-gap"}">${summary}${
    items ? `<ul class="route-obs-list">${items}</ul>` : ""
  }</td>`;
}

function eventRow(row) {
  // routes are pre-joined server-side (diff-view.ts DiffRow.routes) — no client re-normalize.
  const routes = Array.isArray(row.routes) ? row.routes : [];
  return `<tr>
    ${labelCell(row.label, row.aggregate)}
    ${layerCell(row.intent)}
    ${layerCell(row.structure)}
    ${behaviorCell(routes)}
  </tr>`;
}

function legend() {
  return `
    <div class="diff-legend">
      <span class="legend-item"><span class="legend-dot legend-ok"></span>在（aligned）</span>
      <span class="legend-item"><span class="legend-dot legend-gap"></span>欠（gap）</span>
      <span class="legend-item muted-note">behavior 列は直接観測ではなく、そのイベントを発火する route が実行時に観測された場合の逆算推測です。</span>
    </div>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let diff;
  try {
    diff = await fetchJson("/diff.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">観測マップ（イベント）の取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const events = Array.isArray(diff && diff.events) ? diff.events : [];
  if (events.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">観測マップ — イベント</h2>
      <p class="empty">イベントがありません。ダッシュボードの「メニュー状況」で intent / structure フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const rows = events.map((row) => eventRow(row)).join("");
  const candidates = Array.isArray(diff.candidates && diff.candidates.events) ? diff.candidates.events : [];

  el.innerHTML = `
    <h2 class="view-title">観測マップ — イベント</h2>
    <p class="view-desc">intent を軸に structure / behavior を横並びで比較します（緑=一致 / 黄=gap）。</p>
    ${legend()}
    ${statsLine(diff.stats && diff.stats.events)}
    <table class="data-table diff-table">
      <thead><tr><th>イベント（intent）</th><th>intent</th><th>structure</th><th>behavior</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${candidateList(candidates)}
  `;
}
