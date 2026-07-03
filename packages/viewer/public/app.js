// packages/viewer/public/app.js
//
// Hash router for the crawl-kit viewer SPA. Plain ES module, no deps, no build.
// Each route maps to a view module under /views/<file>.js exporting an async
// render(el) — the view fetches its own data and paints itself into `el`.
// Routing never throws to the console: a bad route falls back to the
// dashboard, and a view load/render failure paints an inline error box.

const VIEW_ROOT = document.getElementById("view");

// hash path -> /views/<file>.js. Only "dashboard" ships in this task; the
// rest are wired ahead of their views landing (P5 Task 4+) so the router
// shape doesn't have to change later — an import 404 renders an error box,
// it doesn't crash the shell.
const ROUTES = {
  "/": "dashboard",
  "/intent/events": "intent-events",
  "/intent/aggregates": "intent-aggregates",
  "/intent/transitions": "intent-transitions",
  "/structure/routes": "structure-routes",
  "/structure/usecases": "structure-usecases",
  "/structure/entities": "structure-entities",
  "/structure/er": "structure-er",
  "/structure/uc-entity": "structure-uc-entity",
  "/behavior/traffic": "behavior-traffic",
  "/behavior/sitemap": "behavior-sitemap",
  "/map/events": "map-events",
  "/map/transitions": "map-transitions",
  "/map/boundary": "map-boundary",
};

/** Escape untrusted text before interpolating into innerHTML. Views that
 *  render JSON-sourced values MUST route them through this. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/** Shared fetch-JSON helper for views. Throws on network/HTTP failure — views
 *  catch it and render their own inline error box (never console.log/error). */
export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function currentPath() {
  const hash = location.hash.replace(/^#/, "");
  return hash === "" ? "/" : hash;
}

function renderErrorBox(el, error) {
  const message = error && error.message ? error.message : String(error);
  el.innerHTML = `<div class="error-box">表示中にエラーが発生しました: <code>${esc(message)}</code></div>`;
}

function syncActiveNav(path) {
  document.querySelectorAll("#nav-list a[data-route]").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === path);
  });
}

async function renderRoute() {
  const path = currentPath();
  const known = Object.prototype.hasOwnProperty.call(ROUTES, path);
  const file = known ? ROUTES[path] : ROUTES["/"];
  syncActiveNav(known ? path : "/");
  VIEW_ROOT.innerHTML = "";
  try {
    const mod = await import(`/views/${file}.js`);
    await mod.render(VIEW_ROOT);
  } catch (error) {
    renderErrorBox(VIEW_ROOT, error);
  }
}

window.addEventListener("hashchange", renderRoute);
renderRoute();
