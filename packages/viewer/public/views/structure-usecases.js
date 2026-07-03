// packages/viewer/public/views/structure-usecases.js
//
// structure menu: usecase roster (/view-model.json's usecases) + the usecase diagram
// (mermaid_sources.usecase_diagram). The table ports the old single-file viewer's
// ucTable() (packages/viewer/index.html); the diagram uses the same mermaid mechanism
// as structure-er.js, via the shared /mermaid-render.js loader.

import { fetchJson, esc } from "/app.js";
import { renderMermaid } from "/mermaid-render.js";

function crudSpan(crud) {
  return (crud || []).map((c) => `<span class="crud crud-${esc(c)}">${esc(c)}</span>`).join("");
}

function usecaseRow(u) {
  return `<tr>
    <td>${esc(u.id)}</td>
    <td>${esc(u.name)}</td>
    <td>${esc((u.related_entities || []).join(", "))}</td>
    <td>${(u.related_routes || []).length}</td>
    <td>${crudSpan(u.crud)}</td>
  </tr>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/view-model.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">ユースケースの取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const usecases = Array.isArray(model && model.usecases) ? model.usecases : [];
  if (usecases.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">ユースケース</h2>
      <p class="empty">ユースケースがありません。ダッシュボードの「メニュー状況」で structure フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const rows = usecases.map(usecaseRow).join("");
  el.innerHTML = `
    <h2 class="view-title">ユースケース</h2>
    <table class="data-table">
      <thead><tr><th>ID</th><th>名称</th><th>対象エンティティ</th><th>ルート数</th><th>CRUD</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3 class="section-title">ユースケース図</h3>
    <div class="diagram-wrap" id="uc-diagram"></div>
  `;

  const source = model && model.mermaid_sources ? model.mermaid_sources.usecase_diagram : "";
  await renderMermaid(el.querySelector("#uc-diagram"), source, "ユースケース図がありません。");
}
