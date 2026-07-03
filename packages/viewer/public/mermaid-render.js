// packages/viewer/public/mermaid-render.js
//
// Shared mermaid rendering helper for structure-er.js and structure-usecases.js.
// Ports the exact mechanism the old single-file viewer used (packages/viewer/index.html):
// mermaid@10 from the jsdelivr CDN, `mermaid.initialize({startOnLoad:false,
// theme:"default", securityLevel:"loose"})`, then `mermaid.render(id, source)` →
// `{svg}` dropped straight into innerHTML. The old page loaded the CDN <script> eagerly
// in <head> on every page load; the SPA has no reason to pay that weight on routes that
// never touch a diagram, so this module injects the same <script> tag lazily, the first
// time a diagram view needs it, and caches the load so repeat visits are free. Any
// failure (CDN unreachable, parse error) falls back to a <pre> of the raw source — same
// failure class the old viewer had (it wrapped mermaid.render in try/catch and printed
// the error), just also covering "script never loaded".

import { esc } from "/app.js";

const MERMAID_CDN_URL = "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js";

let mermaidLoadPromise = null;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoadPromise) return mermaidLoadPromise;
  mermaidLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MERMAID_CDN_URL;
    script.onload = () => {
      if (!window.mermaid) {
        reject(new Error("mermaid script loaded but window.mermaid is undefined"));
        return;
      }
      window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });
      resolve(window.mermaid);
    };
    script.onerror = () => reject(new Error(`mermaid の読み込みに失敗しました: ${MERMAID_CDN_URL}`));
    document.head.appendChild(script);
  });
  return mermaidLoadPromise;
}

/** Render mermaid `source` into `el`. Empty/missing source shows `emptyMessage`;
 *  a load or parse failure falls back to a raw-source <pre> plus an inline error. */
export async function renderMermaid(el, source, emptyMessage) {
  if (!el) return;
  if (!source || !source.trim()) {
    el.innerHTML = `<p class="empty">${esc(emptyMessage)}</p>`;
    return;
  }
  try {
    const mermaid = await loadMermaid();
    const id = `mmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { svg } = await mermaid.render(id, source);
    el.innerHTML = svg;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    el.innerHTML = `
      <div class="error-box">図の描画に失敗しました: <code>${esc(message)}</code></div>
      <pre class="mermaid-fallback">${esc(source)}</pre>
    `;
  }
}
