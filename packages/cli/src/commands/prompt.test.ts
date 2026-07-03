import { describe, expect, it } from "vitest";
import { makeReadlinePrompter, NonInteractiveError } from "./prompt.js";

describe("makeReadlinePrompter", () => {
  it("throws NonInteractiveError and never opens readline when isTTY is false", async () => {
    const { ask, close } = makeReadlinePrompter(() => false);
    await expect(ask("q: ")).rejects.toThrow(NonInteractiveError);
    await expect(ask("q2: ")).rejects.toThrow(
      /repositories を \.crawl-kit\/workspace\.yaml に記載してから再実行してください/,
    );
    expect(() => close()).not.toThrow(); // close() before any readline was created must be a no-op
  });

  it("close() is safe to call more than once", () => {
    const { close } = makeReadlinePrompter(() => false);
    close();
    expect(() => close()).not.toThrow();
  });
});
