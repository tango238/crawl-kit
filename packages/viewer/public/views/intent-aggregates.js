// packages/viewer/public/views/intent-aggregates.js
//
// intent menu: aggregate roster (/api/intent.json's aggregates). Each card shows the
// aggregate's members (intent.aggregates.json) and the structure entities mapping.aggregate-
// entity.json realized it as (joinIntentModel in intent-model.ts, packages/viewer/src/intent-
// model.ts). IntentAggregate.entities carries the rich {entity, repo, confidence, evidence}
// shape (mirroring AggregateEntityMapping in packages/reconciler/src/aggregate-mapping.ts);
// entityItem() also still accepts a bare string for defensiveness against older data.
// model.unassigned (structure entities the reconciler couldn't match to any aggregate) is
// rendered by unassignedSection() below, "if present" — empty array renders nothing.

import { fetchJson, esc } from "/app.js";

function memberItem(member) {
  const name = (member && member.name) || "";
  const via = member && member.via ? ` <small>(${esc(member.via)})</small>` : "";
  return `<li>${esc(name)}${via}</li>`;
}

function entityItem(entity) {
  if (entity == null) return "";
  if (typeof entity === "string") {
    return `<li><span class="entity-name">${esc(entity)}</span></li>`;
  }
  const name = entity.entity ?? entity.name ?? "";
  const repo = entity.repo ? ` <span class="entity-repo">${esc(entity.repo)}</span>` : "";
  const confidence =
    typeof entity.confidence === "number"
      ? ` <span class="entity-confidence">${Math.round(entity.confidence * 100)}%</span>`
      : "";
  const evidence = entity.evidence ? `<div class="entity-evidence">${esc(entity.evidence)}</div>` : "";
  return `<li><span class="entity-name">${esc(name)}</span>${repo}${confidence}${evidence}</li>`;
}

function aggregateCard(agg) {
  const members = Array.isArray(agg.members) ? agg.members : [];
  const entities = Array.isArray(agg.entities) ? agg.entities : [];
  const memberList = members.length
    ? `<ul>${members.map(memberItem).join("")}</ul>`
    : `<p class="empty">メンバーがありません。</p>`;
  const entityList = entities.length
    ? `<ul>${entities.map(entityItem).join("")}</ul>`
    : `<p class="empty">マッピングされたエンティティがありません。</p>`;
  return `
    <div class="aggregate-card">
      <h3>${esc(agg.name)}</h3>
      <div class="aggregate-section">
        <h4>メンバー</h4>
        ${memberList}
      </div>
      <div class="aggregate-section">
        <h4>マッピングされたエンティティ</h4>
        ${entityList}
      </div>
    </div>`;
}

function unassignedSection(unassigned) {
  if (!Array.isArray(unassigned) || unassigned.length === 0) return "";
  return `
    <h3 class="section-title">未割当エンティティ</h3>
    <div class="aggregate-section"><ul>${unassigned.map(entityItem).join("")}</ul></div>
  `;
}

export async function render(el) {
  el.innerHTML = `<p class="loading">読み込み中…</p>`;

  let model;
  try {
    model = await fetchJson("/api/intent.json");
  } catch (error) {
    el.innerHTML = `<div class="error-box">集約の取得に失敗しました: <code>${esc(error.message)}</code></div>`;
    return;
  }

  const aggregates = Array.isArray(model && model.aggregates) ? model.aggregates : [];
  if (aggregates.length === 0) {
    el.innerHTML = `
      <h2 class="view-title">集約</h2>
      <p class="empty">集約がありません。ダッシュボードの「メニュー状況」で intent フェーズの案内を確認してください。</p>
    `;
    return;
  }

  el.innerHTML = `
    <h2 class="view-title">集約</h2>
    <div class="aggregate-cards">${aggregates.map(aggregateCard).join("")}</div>
    ${unassignedSection(model && model.unassigned)}
  `;
}
