// packages/structure/src/analyze/investigate.ts
//
// The "investigate" half of the feedback loop. A human says "entity X is wrong / missing";
// instead of re-running the whole 40-minute analysis, we ask the LLM a SCOPED question
// about just that entity — its columns and the CRUD operations the code performs on it,
// WITH file evidence — and turn the answer into a proposed Correction. Deterministic
// fallback: no LLM backend → returns null and the human writes the correction by hand.

import { buildContext, formatContextForPrompt } from "./context/project-context.js";
import { getProvider, type LlmProvider } from "./llm/provider.js";
import type { Correction } from "../corrections.js";

export interface Investigation {
  entity: string;
  exists: boolean;
  attributes: string[];
  crud: Array<"C" | "R" | "U" | "D">;
  evidence: string[];
  /** ready-to-apply corrections derived from the finding. */
  proposed: Correction[];
}

const OPS = ["C", "R", "U", "D"] as const;

export async function investigateEntity(
  repoPath: string,
  entity: string,
  hint: string | undefined,
  llmOverride?: LlmProvider | null,
): Promise<Investigation | null> {
  const llm = llmOverride !== undefined ? llmOverride : getProvider();
  if (!llm || typeof llm.analyzeCodebase !== "function") return null;

  const context = formatContextForPrompt([buildContext(repoPath)]);
  const prompt = `${context}

## 調査対象エンティティ
「${entity}」${hint ? `（補足: ${hint}）` : ""}

## 指示
上記エンティティ（DBテーブル/モデル）について、このリポジトリのソースコードを調べて、以下を**コード上の事実**として特定してください。
1. このエンティティが実在するか（テーブル/モデルが存在するか）
2. 主要な属性（カラム/フィールド）
3. このエンティティに対する **CRUD 操作**（C=作成 / R=参照 / U=更新 / D=削除）。
   HTTPメソッドではなく、Controller/Service/Repository/Job 等の**実際のコード**で判断すること（間接操作も含む）。
4. 根拠（ファイルパス・該当箇所）

以下のJSON形式のみを返してください（説明不要）:
{
  "exists": true,
  "attributes": ["id", "name", "..."],
  "crud": ["C", "R", "U", "D"],
  "evidence": ["app/Services/HotelService.php: update()", "..."]
}`;

  let text: string;
  try {
    text = await llm.analyzeCodebase(repoPath, prompt);
  } catch {
    return null;
  }

  const match = text.replace(/```(?:json)?/g, "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: { exists?: boolean; attributes?: string[]; crud?: string[]; evidence?: string[] };
  try {
    parsed = JSON.parse(match[0]) as typeof parsed;
  } catch {
    return null;
  }

  const exists = parsed.exists !== false;
  const attributes = parsed.attributes ?? [];
  const crud = (parsed.crud ?? []).filter((c): c is (typeof OPS)[number] => (OPS as readonly string[]).includes(c));
  const evidence = parsed.evidence ?? [];

  const proposed: Correction[] = [];
  if (!exists) {
    proposed.push({ kind: "remove-entity", entity, note: "investigate: not found in code" });
  } else {
    proposed.push({ kind: "add-entity", entity, attributes, note: `investigate: ${evidence[0] ?? "found in code"}` });
    if (attributes.length) proposed.push({ kind: "set-attributes", entity, attributes, note: "investigate" });
    if (crud.length) proposed.push({ kind: "set-crud", entity, crud, note: `investigate: ${evidence.slice(0, 2).join("; ")}` });
  }

  return { entity, exists, attributes, crud, evidence, proposed };
}
