// packages/structure/src/analyze/llm/provider.ts
//
// ← llm/provider.py + claude_code_provider.py + anthropic_provider.py + config.py.
// Two backends behind one interface, selected by env exactly as the original:
//   USE_CLAUDE_CODE=true → shell out to `claude` (local, no API key, autonomous
//                          code exploration via analyzeCodebase)
//   ANTHROPIC_API_KEY     → Anthropic API (CI/prod), context-only inference
// With neither set, getProvider() returns null and the parser uses its deterministic
// fallbacks — the suite stays runnable offline.

import { makeLimiter, resolveClaudeCodeConcurrency, type Limiter } from "@crawl-kit/contract";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  readonly providerName: string;
  readonly modelName: string;
  /** single-shot completion → text. (← complete_simple) */
  completeSimple(userMessage: string, systemPrompt?: string, maxTokens?: number): Promise<string>;
  /**
   * Autonomous codebase exploration with filesystem tools, run with cwd=path.
   * Present only on the Claude Code backend (← analyze_codebase). The parser feature-
   * detects this to choose LLM-driven vs context-only extraction.
   */
  analyzeCodebase?(path: string, prompt: string, timeout?: number): Promise<string>;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes"].includes(v.trim().toLowerCase());
}

type Env = Record<string, string | undefined>;

const DEFAULT_MODEL = "claude-opus-4-8";

/** Resolve the provider from the environment, or null when no backend is configured. */
export function getProvider(env: Env = process.env): LlmProvider | null {
  const provider = truthy(env.USE_CLAUDE_CODE)
    ? claudeCodeProvider(env)
    : env.ANTHROPIC_API_KEY
      ? anthropicProvider(env.ANTHROPIC_API_KEY, env)
      : null;
  if (!provider) return null;
  // One shared cap for BOTH backends (same CLAUDE_CODE_MAX_CONCURRENCY env as behavior):
  // bounds live `claude` subprocesses for claude-code, and concurrent requests for the API.
  return withConcurrencyLimit(provider, makeLimiter(resolveClaudeCodeConcurrency(undefined, env)));
}

/** Wrap a provider so every model call passes through the shared concurrency limiter. */
function withConcurrencyLimit(provider: LlmProvider, limit: Limiter): LlmProvider {
  return {
    providerName: provider.providerName,
    modelName: provider.modelName,
    completeSimple: (userMessage, systemPrompt, maxTokens) =>
      limit(() => provider.completeSimple(userMessage, systemPrompt, maxTokens)),
    analyzeCodebase: provider.analyzeCodebase
      ? (path, prompt, timeout) => limit(() => provider.analyzeCodebase!(path, prompt, timeout))
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Claude Code CLI backend (← claude_code_provider.py)
// ---------------------------------------------------------------------------

function parseCliOutput(output: string): string {
  if (!output) return "";
  try {
    const data = JSON.parse(output) as unknown;
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === "object" && (item as { type?: string }).type === "result") {
          const r = (item as { result?: unknown }).result;
          if (r) return String(r);
        }
      }
      const texts: string[] = [];
      for (const item of data) {
        if (item && typeof item === "object" && (item as { type?: string }).type === "assistant") {
          const content = ((item as { message?: { content?: unknown[] } }).message?.content ?? []) as Array<{ type?: string; text?: string }>;
          for (const block of content) {
            if (block?.type === "text" && block.text) texts.push(block.text);
          }
        }
      }
      if (texts.length > 0) return texts[texts.length - 1]!;
    }
    if (data && typeof data === "object") {
      const obj = data as { result?: unknown; content?: unknown };
      if ("result" in obj) return String(obj.result);
      if (Array.isArray(obj.content)) {
        return (obj.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
      }
      if (obj.content !== undefined) return String(obj.content);
    }
  } catch {
    /* not JSON */
  }
  return output;
}

function claudeCodeProvider(env: Env): LlmProvider {
  const model = env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  const allowedTools = env.CLAUDE_ALLOWED_TOOLS ?? "Read,Glob,Grep,Bash";
  const maxTurns = env.CLAUDE_MAX_TURNS ?? "100";
  const analyzeTimeout = Number(env.CLAUDE_ANALYZE_TIMEOUT ?? "600");

  // Concurrency is bounded by the shared limiter in getProvider (covers both backends).
  async function run(args: string[], input: string, cwd: string | undefined, timeoutMs: number): Promise<string> {
    const { execFile } = await import("node:child_process");
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        "claude",
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`claude CLI failed: ${(stderr || error.message).slice(0, 500)}`));
            return;
          }
          resolve(parseCliOutput(stdout.trim()));
        },
      );
      child.stdin?.end(input);
    });
  }

  return {
    providerName: "claude_code",
    modelName: model,
    async completeSimple(userMessage, systemPrompt = "") {
      const prompt = systemPrompt ? `<system>\n${systemPrompt}\n</system>\n\nHuman: ${userMessage}` : `Human: ${userMessage}`;
      return run(["--output-format", "json", "--model", model, "--print"], prompt, undefined, 300_000);
    },
    async analyzeCodebase(path, prompt, timeout) {
      const effective = (timeout && timeout !== 600 ? timeout : analyzeTimeout) * 1000;
      return run(
        ["--output-format", "json", "--model", model, "--print", "--allowedTools", allowedTools, "--max-turns", maxTurns],
        prompt,
        path,
        effective,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic API backend (← anthropic_provider.py) — plain fetch, no SDK.
// ---------------------------------------------------------------------------

function anthropicProvider(apiKey: string, env: Env): LlmProvider {
  const model = env.ANTHROPIC_MODEL ?? env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  return {
    providerName: "anthropic",
    modelName: model,
    async completeSimple(userMessage, systemPrompt = "", maxTokens = 8192) {
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: userMessage }],
      };
      if (systemPrompt) body.system = systemPrompt;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      return data.content?.map((c) => c.text ?? "").join("") ?? "";
    },
  };
}
