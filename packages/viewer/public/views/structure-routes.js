// packages/viewer/public/views/structure-routes.js
//
// structure menu: route roster (/view-model.json's routes). ViewModel.routes is
// {route, state, behavior} (reconcile state + behavior observation count) — this ports
// the old single-file viewer's routeTable() (packages/viewer/index.html) column-for-column,
// including the reconcile ConceptState colour coding (--st-* custom properties there;
// inlined here as a local map since this module doesn't share :root with the old page).

import { fetchJson, esc } from "/app.js";

const STATE_COLORS = {
  aligned: "#2a9d8f",
  "intent-only": "#4361ee",
  "code-only": "#f4a261",
  "aggregate-internal": "#7d8aa3",
  "implementation-detail": "#7d8aa3",
  adjudicated: "#4361ee",
  "violates-decision": "#e63946",
  unmatched: "#9aa0aa",
};

function stateColor(state) {
  return STATE_COLORS[state] || "#9aa0aa";
}

function routeRow(r) {
  return `<tr>
    <td><code>${esc(r.route)}</code></td>
    <td><span class="state-badge" style="background:${stateColor(r.state)}">${esc(r.state)}</span></td>
    <td>${esc(String(r.behavior ?? 0))}</td>
  </tr>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/view-model.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">ルーティングの取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const routes = Array.isArray(model && model.routes) ? model.routes : [];
  if (routes.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">ルーティング</h2>
      <p class="empty">ルートがありません。ダッシュボードの「メニュー状況」で structure フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const rows = routes.map(routeRow).join("");
  el.innerHTML = `
    <h2 class="view-title">ルーティング</h2>
    <table class="data-table">
      <thead><tr><th>ルート</th><th>状態</th><th>behavior 観測数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
