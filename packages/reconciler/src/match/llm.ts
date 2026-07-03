// packages/reconciler/src/match/llm.ts
//
// The LLM is the LAST resort, not the first. The deterministic signals run first;
// only genuinely ambiguous leftovers reach here, and they arrive WITH the structural
// evidence so the model stays grounded (it judges "are these the same concept given
// these shared attributes", not "vibe-match these names").
//
// Backend selection mirrors rdra/loop-e2e: USE_CLAUDE_CODE → Claude Code CLI,
// else ANTHROPIC_API_KEY → Anthropic API. With neither configured the judge ABSTAINS
// (returns null) so the suite is fully deterministic offline — leftovers simply go to
// the manual queue rather than being guessed.

import type { Evidence } from "@crawl-kit/contract";
import type { IntentConcept, StructureEntity } from "../nodes.js";

export interface LlmJudge {
  readonly model: string;
  judge(
    concept: IntentConcept,
    entity: StructureEntity,
    evidence: Evidence,
  ): Promise<Evidence["llm"] | null>;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes"].includes(v.trim().toLowerCase());
}

/** Abstainer — the offline default. Always returns null (no opinion). */
export const ABSTAIN: LlmJudge = {
  model: "none",
  async judge() {
    return null;
  },
};

/**
 * Resolve the LLM judge from the environment, exactly once per run.
 * Returns ABSTAIN when no backend is configured (CI/offline/default).
 */
export function resolveJudge(env: NodeJS.ProcessEnv = process.env): LlmJudge {
  if (truthy(env.USE_CLAUDE_CODE)) return claudeCodeJudge();
  if (env.ANTHROPIC_API_KEY) return anthropicJudge(env.ANTHROPIC_API_KEY);
  return ABSTAIN;
}

function prompt(concept: IntentConcept, entity: StructureEntity, evidence: Evidence): string {
  return [
    "You are reconciling a domain model against a database schema.",
    "Decide whether the glossary concept and the code entity denote the SAME concept.",
    `Concept: ${concept.canonicalName} (attrs: ${concept.attributes.join(", ")})`,
    `Entity:  ${entity.name} (attrs: ${entity.attributes.join(", ")})`,
    `Structural evidence: ${JSON.stringify(evidence)}`,
    'Reply with strict JSON: {"same": boolean, "confidence": 0..1, "rationale": string}.',
  ].join("\n");
}

/** Anthropic API client (no SDK dependency — plain fetch). Not exercised offline. */
function anthropicJudge(apiKey: string): LlmJudge {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
  return {
    model,
    async judge(concept, entity, evidence) {
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 256,
            messages: [{ role: "user", content: prompt(concept, entity, evidence) }],
          }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { content?: Array<{ text?: string }> };
        const text = data.content?.map((c) => c.text ?? "").join("") ?? "";
        return parseJudgement(text, model);
      } catch {
        return null; // network/parse failure → abstain, never crash the pipeline
      }
    },
  };
}

/** Claude Code CLI client — shells out to `claude -p`. Not exercised offline. */
function claudeCodeJudge(): LlmJudge {
  const model = "claude-code";
  return {
    model,
    async judge(concept, entity, evidence) {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const run = promisify(execFile);
        const { stdout } = await run("claude", ["-p", prompt(concept, entity, evidence)], {
          timeout: 30_000,
        });
        return parseJudgement(stdout, model);
      } catch {
        return null;
      }
    },
  };
}

function parseJudgement(text: string, model: string): Evidence["llm"] | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { same?: boolean; confidence?: number; rationale?: string };
    const score = parsed.same ? (parsed.confidence ?? 0.5) : 0;
    return { score, rationale: parsed.rationale ?? "", model };
  } catch {
    return null;
  }
}
