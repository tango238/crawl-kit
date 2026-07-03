// packages/viewer/public/views/behavior-traffic.js
//
// behavior menu: 通信ログ (/api/traffic.json → TrafficModel, packages/viewer/src/traffic-
// model.ts). TrafficModel.routes is structure-route-axis groups {route, method, key, pathKey,
// txs}; each tx carries {seq, ts, stage, status?, ok, requestQuery?, requestBody?, responseBody?,
// persisted?}. TrafficModel.pages is {url, key, pathKey, elements:[{kind:"link"|"click", label?,
// to}]} — kept only for GET routes (joinTrafficPages). Both `key` (normalizeRoute("METHOD /path"))
// and `pathKey` (same, method stripped) are computed server-side (traffic-model.ts, which owns the
// @crawl-kit/contract dependency this plain-ES-module browser bundle doesn't have) — a route row's
// "screen elements" section looks up the page sharing the row's `pathKey`, so mutation routes
// (POST/PATCH/DELETE, which never have their own GET page) still surface the elements of the GET
// page at the same path.
//
// Each route renders as one <details> "row" (grid-aligned to a fake table header) rather than a
// real <table><tr> — <details> can't be a valid direct child of <tbody>, and the task brief
// explicitly allows "<details> でよい" for the click-to-expand row.

import { fetchJson, esc } from "/app.js";

function findPageForRoute(route, pages) {
  return pages.find((p) => p.pathKey === route.pathKey);
}

function persistedClass(value) {
  return value === "yes" || value === "no" ? value : "unknown";
}

function persistedCounts(txs) {
  const counts = { yes: 0, no: 0, unknown: 0 };
  for (const tx of txs) counts[persistedClass(tx.persisted)] += 1;
  return counts;
}

function persistedBadges(counts) {
  return ["yes", "no", "unknown"]
    .filter((key) => counts[key] > 0)
    .map((key) => `<span class="persisted-badge persisted-${key}">${esc(key)}:${counts[key]}</span>`)
    .join("");
}

function elementKindClass(kind) {
  return kind === "click" ? "click" : "link";
}

function elementItem(element) {
  const kindClass = elementKindClass(element.kind);
  const label = element.label ? esc(element.label) : "(ラベルなし)";
  const kindTag =
    kindClass === "click"
      ? `<span class="via-badge via-click">click</span><strong>押した:</strong>`
      : `<span class="via-badge via-link">link</span>`;
  return `<li class="page-element page-element-${kindClass}">${kindTag} ${label} → <code>${esc(element.to)}</code></li>`;
}

/** Pretty-print a JSON-ish value for a collapsed <pre>. Falls back to the raw string/value
 *  when it isn't parseable JSON — either way the result is esc()'d by the caller. */
function prettyJson(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function detailBlock(label, value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "object" && Object.keys(value).length === 0) return "";
  return `<details class="tx-detail"><summary>${esc(label)}</summary><pre>${esc(prettyJson(value))}</pre></details>`;
}

function txRow(tx) {
  const key = persistedClass(tx.persisted);
  const details =
    [detailBlock("query", tx.requestQuery), detailBlock("request body", tx.requestBody), detailBlock("response body", tx.responseBody)].join(
      "",
    ) || `<span class="empty-inline">-</span>`;
  // Cross-reference to 画面遷移: the screen this request fired on (behavior stamps tx.pageUrl).
  const page = tx.pageUrl ? `<code class="tx-page-url">${esc(tx.pageUrl)}</code>` : `<span class="empty-inline">-</span>`;
  return `<tr>
    <td>${esc(String(tx.seq))}</td>
    <td>${esc(tx.ts)}</td>
    <td>${esc(tx.stage)}</td>
    <td>${esc(tx.status !== undefined ? String(tx.status) : "-")}</td>
    <td><span class="persisted-badge persisted-${key}">${esc(key)}</span></td>
    <td>${page}</td>
    <td>${details}</td>
  </tr>`;
}

function routeRow(route, pages) {
  const page = findPageForRoute(route, pages);
  const elements = page && Array.isArray(page.elements) ? page.elements : [];
  const elementsHtml = elements.length
    ? `<ul class="page-elements">${elements.map(elementItem).join("")}</ul>`
    : `<p class="empty-inline">対応する画面エレメントがありません。</p>`;
  const txs = Array.isArray(route.txs) ? route.txs : [];
  const txRows = txs.map(txRow).join("");

  return `
    <details class="route-details">
      <summary>
        <span><code>${esc(route.route)}</code></span>
        <span>${esc(route.method)}</span>
        <span>${txs.length} 件</span>
        <span>${persistedBadges(persistedCounts(txs))}</span>
      </summary>
      <div class="route-detail-body">
        <h4>表示エレメント</h4>
        ${elementsHtml}
        <h4>通信一覧</h4>
        <table class="data-table tx-table">
          <thead><tr><th>seq</th><th>ts</th><th>stage</th><th>status</th><th>persisted</th><th>画面</th><th>詳細</th></tr></thead>
          <tbody>${txRows || '<tr><td colspan="7" class="empty-inline">通信がありません。</td></tr>'}</tbody>
        </table>
      </div>
    </details>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/api/traffic.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">通信ログの取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const routes = Array.isArray(model && model.routes) ? model.routes : [];
  const pages = Array.isArray(model && model.pages) ? model.pages : [];

  if (routes.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">通信ログ</h2>
      <p class="empty">通信ログがありません。ダッシュボードの「メニュー状況」で behavior フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const rows = routes.map((route) => routeRow(route, pages)).join("");
  el.innerHTML = `
    <h2 class="view-title">通信ログ</h2>
    <div class="traffic-table">
      <div class="traffic-table-head">
        <span>route</span><span>method</span><span>tx数</span><span>persisted</span>
      </div>
      ${rows}
    </div>
  `;
}
