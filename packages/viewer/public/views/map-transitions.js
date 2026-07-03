// packages/viewer/public/views/map-transitions.js
//
// 観測マップ menu: state transitions (/diff.json's DiffView, packages/viewer/src/diff-
// view.ts). Ports the old single-file viewer's (packages/viewer/index.html) diffView()
// transition section — intent axis, structure side-by-side (diffRows(d.transitions)) —
// plus the transitions half of its "候補" block (d.candidates.transitions).
//
// old block                                                    -> here
// ------------------------------------------------------------------
// diffView() trTbl (intent/structure, diffRows(d.transitions))  -> transitionRow()'s intent/structure <td>s
// diffView() cBlock, transitions half (d.candidates.transitions) -> candidateList(transitions) (map-shared.js)
//
// behavior column: unlike events, DiffView carries no per-transition route/observation
// link (buildDiffView() computes a behavior match per intent transition internally —
// matchedBTrans — but does not expose it on DiffRow; only UNMATCHED behavior transitions
// surface, as candidates below). There is no reliable client-side way to recover a
// positive per-row behavior signal from what /diff.json actually ships, so the column is
// rendered as "not available at this granularity" rather than guessed at — see the
// legend note. The candidates list below is the only cross-layer behavior signal this
// view can show for transitions today.

import { fetchJson, esc } from "/app.js";
import { layerCell, labelCell, statsLine, candidateList } from "/views/map-shared.js";

function transitionRow(row) {
  return `<tr>
    ${labelCell(row.label, row.aggregate)}
    ${layerCell(row.intent)}
    ${layerCell(row.structure)}
    <td class="layer-cell layer-unknown">— <small class="cell-ref">行単位の behavior 観測は diff.json 未提供</small></td>
  </tr>`;
}

function legend() {
  return `
    <div class="diff-legend">
      <span class="legend-item"><span class="legend-dot legend-ok"></span>在（aligned）</span>
      <span class="legend-item"><span class="legend-dot legend-gap"></span>欠（gap）</span>
      <span class="legend-item"><span class="legend-dot legend-unknown"></span>未提供（データなし）</span>
      <span class="legend-item muted-note">behavior 列は状態遷移単位では diff.json が値を提供していません。下部の「候補」に intent 未登録の behavior 観測（逆算推測ではなく直接観測）が並びます。</span>
    </div>`;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let diff;
  try {
    diff = await fetchJson("/diff.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">観測マップ（状態遷移）の取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const transitions = Array.isArray(diff && diff.transitions) ? diff.transitions : [];
  if (transitions.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">観測マップ — 状態遷移</h2>
      <p class="empty">状態遷移がありません。ダッシュボードの「メニュー状況」で intent / structure フェーズの案内を確認してください。</p>
    `;
    return;
  }

  const rows = transitions.map(transitionRow).join("");
  const candidates = Array.isArray(diff.candidates && diff.candidates.transitions) ? diff.candidates.transitions : [];

  el.innerHTML = `
    <h2 class="view-title">観測マップ — 状態遷移</h2>
    <p class="view-desc">intent を軸に structure を横並びで比較します（緑=一致 / 黄=gap）。</p>
    ${legend()}
    ${statsLine(diff.stats && diff.stats.transitions)}
    <table class="data-table diff-table">
      <thead><tr><th>状態遷移（intent）</th><th>intent</th><th>structure</th><th>behavior</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${candidateList(candidates)}
  `;
}
