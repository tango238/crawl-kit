import { createInterface } from "node:readline/promises";

export type Prompter = (question: string) => Promise<string>;

export type ClosablePrompter = {
  ask: Prompter;
  close(): void;
};

/**
 * Thrown by the lazy prompter when a question is asked outside a TTY (stdin isn't
 * interactive — e.g. CI, a piped invocation). `cmdSetup`'s own prompts (repository
 * registration) let this propagate so setup fails fast with a clear message;
 * repo-analysis prompts catch it and fall back to "skip, leave the field undefined".
 */
export class NonInteractiveError extends Error {
  constructor() {
    super("repositories を .crawl-kit/workspace.yaml に記載してから再実行してください");
    this.name = "NonInteractiveError";
  }
}

/**
 * Real stdin prompter. The underlying readline interface is created lazily — only
 * when the first question is actually asked — and exposed via close() so callers can
 * release stdin once done. Never closing it was the cause of `crawl-kit setup` hanging
 * forever after finishing its work (the open readline kept the process alive).
 *
 * `isTTY` is injectable so tests can simulate a non-interactive environment without
 * mutating the real process.stdin.
 */
export function makeReadlinePrompter(isTTY: () => boolean = () => Boolean(process.stdin.isTTY)): ClosablePrompter {
  let rl: ReturnType<typeof createInterface> | null = null;

  const ask: Prompter = async (question: string) => {
    if (!isTTY()) throw new NonInteractiveError();
    if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
    return (await rl.question(question)).trim();
  };

  const close = (): void => {
    rl?.close();
    rl = null;
  };

  return { ask, close };
}
