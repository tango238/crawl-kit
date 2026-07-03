// packages/viewer/public/views/structure-er.js
//
// structure menu: ER diagram (/view-model.json's mermaid_sources.information_model).
// Ports the old single-file viewer's diagram mechanism (packages/viewer/index.html:
// mermaid@10 from the jsdelivr CDN, mermaid.render → svg) via the shared
// /mermaid-render.js loader, which injects the CDN <script> lazily instead of the old
// page's eager <head> load, and falls back to a raw-source <pre> if mermaid can't load
// or render.

import { fetchJson, esc } from "/app.js";
import { renderMermaid } from "/mermaid-render.js";

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/view-model.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">ER図の取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  el.innerHTML = `
    <h2 class="view-title">ER図</h2>
    <div class="diagram-wrap" id="er-diagram"></div>
  `;

  const source = model && model.mermaid_sources ? model.mermaid_sources.information_model : "";
  await renderMermaid(
    el.querySelector("#er-diagram"),
    source,
    "ER図がありません。ダッシュボードの「メニュー状況」で structure フェーズの案内を確認してください。",
  );
}
