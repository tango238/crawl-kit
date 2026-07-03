// packages/viewer/public/views/behavior-sitemap.js
//
// behavior menu: 画面遷移 (/api/sitemap.json → Sitemap | null, packages/viewer/src/traffic-
// model.ts / packages/behavior/src/sitemap.ts's buildSitemap). `null` is the API's explicit
// "not crawled yet" signal (api.ts) and is distinct from an empty-but-crawled sitemap — the two
// get different messages. roots[] is a forest of SitemapNode {url, via?: {kind, label?},
// children}; orphans[] are pages that appeared in the crawl but were never reached by any edge.

import { fetchJson, esc } from "/app.js";

function viaKindClass(kind) {
  return kind === "click" ? "click" : "link";
}

function viaBadge(via) {
  if (!via) return "";
  const kindClass = viaKindClass(via.kind);
  const label = via.label ? ` <span class="via-label">${esc(via.label)}</span>` : "";
  return `<span class="via-badge via-${kindClass}">${esc(kindClass)}</span>${label}`;
}

// Cross-reference to the 通信ログ view: mutation txs stamped with this page's URL
// (traffic-model.ts joinPageMutations). Defensive — missing/empty → no badge, never throws.
function mutationBadge(node) {
  const mutations = Array.isArray(node && node.mutations) ? node.mutations : [];
  if (mutations.length === 0) return "";
  return ` <span class="mutation-badge" title="このページで発生したデータ更新通信">⚙ ${esc(String(mutations.length))} mutations</span>`;
}

function nodeTree(node) {
  const via = viaBadge(node.via);
  const mut = mutationBadge(node);
  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length === 0) {
    return `<li>${via}<code class="sitemap-url">${esc(node.url)}</code>${mut}</li>`;
  }
  return `<li>
    <details open>
      <summary>${via}<code class="sitemap-url">${esc(node.url)}</code>${mut}</summary>
      <ul class="sitemap-children">${children.map(nodeTree).join("")}</ul>
    </details>
  </li>`;
}

function orphansSection(orphans) {
  if (!Array.isArray(orphans) || orphans.length === 0) return "";
  return `
    <h3 class="section-title">孤立ページ</h3>
    <p class="muted-note">どの遷移からも到達しなかったページです。</p>
    <ul class="orphan-list">${orphans.map((url) => `<li><code>${esc(url)}</code></li>`).join("")}</ul>
  `;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let sitemap;
  try {
    sitemap = await fetchJson("/api/sitemap.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">画面遷移の取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  if (sitemap === null) {
    el.innerHTML = `
      <h2 class="view-title">画面遷移</h2>
      <p class="empty">behavior 未実行のため画面遷移データがありません。ダッシュボードの「メニュー状況」で behavior フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const roots = Array.isArray(sitemap.roots) ? sitemap.roots : [];
  const orphans = Array.isArray(sitemap.orphans) ? sitemap.orphans : [];

  if (roots.length === 0 && orphans.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">画面遷移</h2>
      <p class="empty">画面遷移データがありません。ダッシュボードの「メニュー状況」で behavior フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const tree = roots.length
    ? `<ul class="sitemap-tree">${roots.map(nodeTree).join("")}</ul>`
    : `<p class="empty">遷移ツリーがありません。</p>`;

  el.innerHTML = `
    <h2 class="view-title">画面遷移</h2>
    <p class="updated-at">最終更新: ${esc(sitemap.generatedAt || "-")}</p>
    ${tree}
    ${orphansSection(orphans)}
  `;
}
