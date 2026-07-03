// packages/viewer/public/views/intent-transitions.js
//
// intent menu: state transitions (/api/intent.json's transitions), grouped by
// aggregate so a 集約×イベント view falls out of the grouping — each row still carries
// its own `event` column so the aggregate/event correspondence stays visible per row.

import { fetchJson, esc } from "/app.js";

function groupByAggregate(transitions) {
  const groups = new Map();
  for (const t of transitions) {
    const key = t.aggregate || "(未設定)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return groups;
}

function transitionRow(t) {
  return `<tr>
    <td>${esc(t.from)}</td>
    <td>${esc(t.to)}</td>
    <td>${esc(t.trigger || "-")}</td>
    <td>${esc(t.event || "-")}</td>
  </tr>`;
}

function aggregateSection(aggregate, transitions) {
  const rows = transitions.map(transitionRow).join("");
  return `
    <h3 class="section-title">${esc(aggregate)}</h3>
    <table class="data-table">
      <thead><tr><th>from</th><th>to</th><th>トリガー</th><th>イベント</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/api/intent.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">状態遷移の取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const transitions = Array.isArray(model && model.transitions) ? model.transitions : [];
  if (transitions.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">状態遷移</h2>
      <p class="empty">状態遷移がありません。ダッシュボードの「メニュー状況」で intent フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const groups = groupByAggregate(transitions);
  const sections = [...groups.entries()].map(([aggregate, ts]) => aggregateSection(aggregate, ts)).join("");
  el.innerHTML = `<h2 class="view-title">状態遷移</h2>${sections}`;
}
