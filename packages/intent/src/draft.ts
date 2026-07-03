// packages/intent/src/draft.ts
//
// LLM-drafted glossary: turns structure-layer notes (repo summaries, entity
// names, route summaries) into a first-pass Glossary, so a human doesn't
// start the DDD glossary from a blank page. `DraftLlm` is a structural type
// (not imported from @crawl-kit/structure) so intent stays decoupled from
// how the caller talks to its model. The response is trusted only after it
// clears GlossarySchema; one corrective retry absorbs the common failure
// mode (prose wrapping, near-miss JSON) before giving up.

import { GlossarySchema } from "./glossary-schema.js";
import type { Glossary } from "./model.js";

export type DraftLlm = {
  completeSimple(userMessage: string, systemPrompt?: string, maxTokens?: number): Promise<string>;
};

export interface DraftInput {
  repoNotes: Array<{ name: string; framework: string; structureSummary: string }>;
  entityNames?: string[];
  routeSummaries?: string[];
}

const SYSTEM_PROMPT = `あなたはドメイン駆動設計（DDD）の専門家です。与えられたシステム情報から、DDD の観点でドメインモデルのドラフトを JSON で出力してください。

以下のルールに従うこと:
- 集約（aggregate）の kind は必ず "aggregate-root" とする
- kind に使える値は "aggregate-root" | "entity" | "value-object" | "service" | "policy" のいずれかのみ
- イベント名は過去形にする（例: "OrderPlaced"、"注文が作成された" ではなく英語過去形推奨）
- 状態遷移（stateTransitions）で、集約が生成される遷移の from は "∅" とする
- 出力は JSON のみ。説明文・前置き・コードフェンス（\`\`\`）は一切含めないこと

期待する JSON の形（フィールド名を厳密に守ること）:
{
  "concepts": [
    {
      "name": "Order",                    // 必須
      "aliases": ["注文"],                 // 省略可
      "kind": "aggregate-root",           // 省略可。"aggregate-root" | "entity" | "value-object" | "service" | "policy"
      "context": "Ordering",              // 省略可
      "attributes": ["orderId", "status"], // 必須（配列。無ければ空配列）
      "dependsOn": ["Customer"]           // 省略可
    }
  ],
  "events": [
    {
      "name": "OrderPlaced",              // 必須。過去形
      "aggregate": "Order",               // 省略可
      "context": "Ordering",              // 省略可
      "trigger": "PlaceOrder",            // 省略可
      "properties": ["orderId"],          // 省略可
      "consumer": "Fulfillment"           // 省略可
    }
  ],
  "stateTransitions": [
    {
      "aggregate": "Order",               // 必須
      "context": "Ordering",              // 省略可
      "from": "∅",                        // 必須。生成遷移は "∅"
      "to": "Placed",                     // 必須
      "trigger": "PlaceOrder",            // 省略可
      "event": "OrderPlaced"              // 省略可
    }
  ]
}`;

const RETRY_PREFIX = "前回の応答は不正なJSONだった。JSONのみを返せ";

function buildUserMessage(input: DraftInput): string {
  const repoLines = input.repoNotes
    .map((r) => `- ${r.name} (${r.framework}): ${r.structureSummary}`)
    .join("\n");

  const sections = [`## リポジトリ情報\n${repoLines || "(なし)"}`];

  if (input.entityNames && input.entityNames.length > 0) {
    sections.push(`## エンティティ候補\n${input.entityNames.join(", ")}`);
  }
  if (input.routeSummaries && input.routeSummaries.length > 0) {
    sections.push(`## ルート概要\n${input.routeSummaries.join("\n")}`);
  }

  sections.push("上記の情報から、DDD の観点でドメインモデルのドラフトを JSON のみで出力してください。");

  return sections.join("\n\n");
}

/** First `{` to last `}`, or null if no brace pair is present. */
function extractJsonSubstring(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

type ParseAttempt = { ok: true; data: Glossary } | { ok: false; error: string };

function attemptParse(text: string): ParseAttempt {
  const jsonText = extractJsonSubstring(text);
  if (jsonText === null) {
    return { ok: false, error: "response contained no JSON object (no '{'...'}' found)" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JSON.parse failed: ${message}` };
  }

  const result = GlossarySchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, data: result.data };
}

/**
 * Draft a Glossary from structure-layer notes via an LLM. Retries ONCE with a
 * corrective message on any failure (missing JSON, parse error, or schema
 * mismatch); throws if the second attempt also fails.
 */
export async function draftGlossary(input: DraftInput, llm: DraftLlm): Promise<Glossary> {
  const userMessage = buildUserMessage(input);

  const first = await llm.completeSimple(userMessage, SYSTEM_PROMPT);
  const firstAttempt = attemptParse(first);
  if (firstAttempt.ok) return firstAttempt.data;

  const correctiveMessage = `${userMessage}\n\n${RETRY_PREFIX}\n\n${firstAttempt.error}`;
  const second = await llm.completeSimple(correctiveMessage, SYSTEM_PROMPT);
  const secondAttempt = attemptParse(second);
  if (secondAttempt.ok) return secondAttempt.data;

  throw new Error(
    `draftGlossary: LLM response failed validation twice — giving up.\n` +
      `first attempt: ${firstAttempt.error}\n` +
      `second attempt: ${secondAttempt.error}`,
  );
}
