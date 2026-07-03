// packages/viewer/public/views/structure-uc-entity.js
//
// structure menu: usecase × entity CRUD matrix (/view-model.json's uc_entity_crud).
// The old single-file viewer's buildCrossRef() (packages/viewer/index.html) rendered
// rows=entity / cols=usecase; this view transposes to rows=UC / cols=entity per the
// task brief (集約×イベントと同様、UC を主軸に読めるようにする) — the cell lookup and
// CRUD-letter rendering are the same mechanism, just indexed the other way round.

import { fetchJson, esc } from "/app.js";

function crudSpan(crud) {
  return (crud || []).map((c) => `<span class="crud crud-${esc(c)}">${esc(c)}</span>`).join("");
}

function matrixTable(usecases, entities, ucEntityCrud) {
  const header =
    `<th class="row-head">UC \\ エンティティ</th>` +
    entities.map((e) => `<th title="${esc(e.name)}">${esc(e.name)}</th>`).join("");
  const rows = usecases
    .map((u) => {
      const cells = entities
        .map((e) => {
          const crud = (ucEntityCrud[u.id] || {})[e.name] || [];
          return `<td>${crud.length ? crudSpan(crud) : ""}</td>`;
        })
        .join("");
      return `<tr><td class="row-head" title="${esc(u.name)}">${esc(u.id)} ${esc(u.name)}</td>${cells}</tr>`;
    })
    .join("");
  return `<table class="matrix-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/view-model.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">エンティティ×UC の取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const usecases = Array.isArray(model && model.usecases) ? model.usecases : [];
  const entities = Array.isArray(model && model.entities) ? model.entities : [];
  const ucEntityCrud = (model && model.uc_entity_crud) || {};

  if (usecases.length === 0 || entities.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">エンティティ×UC</h2>
      <p class="empty">マトリクスに十分なデータがありません。ダッシュボードの「メニュー状況」で structure フェーズの案内を確認してください。</p>
    `;
    return;
  }

  el.innerHTML = `
    <h2 class="view-title">エンティティ×UC</h2>
    <div class="matrix-wrap">${matrixTable(usecases, entities, ucEntityCrud)}</div>
  `;
}
