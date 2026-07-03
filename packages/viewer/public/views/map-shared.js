// packages/viewer/public/views/map-shared.js
//
// Shared helpers for the 3 観測マップ views (map-events.js, map-transitions.js,
// map-boundary.js) — all three read the SAME /diff.json (DiffView, packages/viewer/
// src/diff-view.ts) and share the intent/structure/behavior "layer cell" rendering
// ported from the old single-file viewer (packages/viewer/index.html)'s dcell()/pcell()/
// diffRows(). Kept here (mirroring the mermaid-render.js precedent for structure-er.js /
// structure-usecases.js) so each view file stays focused on its own section of the page.

import { esc } from "/app.js";

/** One <td> for an intent/structure Cell ({present, shape, ref}) — green when present
 *  (aligned), amber when absent (gap). Ports dcell() from the old viewer. */
export function layerCell(cell) {
  if (!cell || !cell.present) {
    const ref = (cell && cell.ref) || "";
    return `<td class="layer-cell layer-gap">⚠ 欠${ref ? ` <small class="cell-ref">${esc(ref)}</small>` : ""}</td>`;
  }
  return `<td class="layer-cell layer-ok"><code>${esc(cell.shape || "")}</code>${
    cell.ref ? ` <small class="cell-ref">${esc(cell.ref)}</small>` : ""
  }</td>`;
}

/** The row label cell (intent axis label + optional aggregate sub-label). */
export function labelCell(label, aggregate) {
  return `<th class="row-label">${esc(label)}${aggregate ? `<br><small class="cell-ref">${esc(aggregate)}</small>` : ""}</th>`;
}

/** "N/total aligned (gap M)" summary line for a DiffView stats.events / stats.transitions bucket. */
export function statsLine(stats) {
  if (!stats) return "";
  return `<p class="muted-note">${esc(String(stats.aligned))}/${esc(String(stats.total))} aligned・gap ${esc(String(stats.gap))}</p>`;
}

/** "候補（intent に無い）" list — structure/behavior-only items with no intent match.
 *  Ports the old viewer's diffView() cBlock. Not a defect: surfaced separately so it
 *  doesn't skew the intent-axis aligned/gap tally above. */
export function candidateList(candidates) {
  if (!candidates || candidates.length === 0) return "";
  const items = candidates
    .map(
      (c) =>
        `<li><code>${esc(c.label)}</code> <span class="cand-layer">${esc(c.layer)}</span>${
          c.ref ? ` <small class="cell-ref">${esc(c.ref)}</small>` : ""
        }</li>`,
    )
    .join("");
  return `
    <h3 class="section-title">候補（intent に無い）</h3>
    <p class="muted-note">structure / behavior 側にのみ観測された項目です。欠陥ではなく、intent への追加候補として提示します。</p>
    <ul class="candidate-list">${items}</ul>`;
}
