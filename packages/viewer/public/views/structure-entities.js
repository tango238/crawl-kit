// packages/viewer/public/views/structure-entities.js
//
// structure menu: entity roster (/view-model.json's entities) — name, attributes,
// and the dependency edges (dependsOn), one row per entity.

import { fetchJson, esc } from "/app.js";

function entityRow(e) {
  const attributes = (e.attributes || []).join(", ") || "-";
  const dependsOn = (e.dependsOn || []).join(", ") || "-";
  return `<tr>
    <td>${esc(e.name)}</td>
    <td>${esc(attributes)}</td>
    <td>${esc(dependsOn)}</td>
  </tr>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/view-model.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">エンティティの取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const entities = Array.isArray(model && model.entities) ? model.entities : [];
  if (entities.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">エンティティ</h2>
      <p class="empty">エンティティがありません。ダッシュボードの「メニュー状況」で structure フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const rows = entities.map(entityRow).join("");
  el.innerHTML = `
    <h2 class="view-title">エンティティ</h2>
    <table class="data-table">
      <thead><tr><th>エンティティ</th><th>属性</th><th>依存先</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
