// packages/viewer/public/views/intent-events.js
//
// intent menu: event roster (/api/intent.json's events). IntentModel
// (packages/viewer/src/intent-model.ts) shapes each entry as
// {name, aggregate, trigger, properties, consumer} — rendered straight into a table.

import { fetchJson, esc } from "/app.js";

function eventRow(e) {
  const properties = (e.properties || []).join(", ");
  return `<tr>
    <td>${esc(e.name)}</td>
    <td>${esc(e.aggregate || "-")}</td>
    <td>${esc(e.trigger || "-")}</td>
    <td>${esc(properties || "-")}</td>
    <td>${esc(e.consumer || "-")}</td>
  </tr>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/api/intent.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">イベントの取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const events = Array.isArray(model && model.events) ? model.events : [];
  if (events.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">イベント</h2>
      <p class="empty">イベントがありません。ダッシュボードの「メニュー状況」で intent フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const rows = events.map(eventRow).join("");
  el.innerHTML = `
    <h2 class="view-title">イベント</h2>
    <table class="data-table">
      <thead><tr><th>イベント</th><th>集約</th><th>トリガー</th><th>プロパティ</th><th>コンシューマ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
