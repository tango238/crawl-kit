import { describe, it, expect } from "vitest"
import {
  makeLimiter,
  resolveClaudeCodeConcurrency,
  DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY,
} from "./concurrency.js"

/** Resolves on the next macrotask so we can observe in-flight counts deterministically. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("makeLimiter", () => {
  it("never runs more than `max` tasks at once", async () => {
    const limit = makeLimiter(2)
    let active = 0
    let peak = 0
    const release: Array<() => void> = []

    const tasks = Array.from({ length: 6 }, () =>
      limit(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => release.push(resolve))
        active -= 1
      }),
    )

    await tick()
    expect(active).toBe(2)

    while (release.length > 0) {
      release.shift()!()
      await tick()
    }
    await Promise.all(tasks)
    expect(peak).toBe(2)
  })

  it("runs everything to completion in order of arrival", async () => {
    const limit = makeLimiter(1)
    const order: number[] = []
    await Promise.all([1, 2, 3].map((n) => limit(async () => { order.push(n) })))
    expect(order).toEqual([1, 2, 3])
  })

  it("returns each task’s resolved value", async () => {
    const limit = makeLimiter(2)
    const results = await Promise.all([limit(async () => "a"), limit(async () => "b")])
    expect(results).toEqual(["a", "b"])
  })

  it("propagates rejections without stalling the queue", async () => {
    const limit = makeLimiter(1)
    await expect(limit(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    await expect(limit(async () => "after")).resolves.toBe("after")
  })

  it("treats max < 1 as 1 (never zero concurrency)", async () => {
    const limit = makeLimiter(0)
    await expect(limit(async () => "ok")).resolves.toBe("ok")
  })
})

describe("resolveClaudeCodeConcurrency", () => {
  it("prefers the explicit option over env and default", () => {
    expect(resolveClaudeCodeConcurrency(7, { CLAUDE_CODE_MAX_CONCURRENCY: "2" })).toBe(7)
  })

  it("falls back to the env var when no option is given", () => {
    expect(resolveClaudeCodeConcurrency(undefined, { CLAUDE_CODE_MAX_CONCURRENCY: "5" })).toBe(5)
  })

  it("falls back to the default when neither option nor a positive env is set", () => {
    expect(resolveClaudeCodeConcurrency(undefined, {})).toBe(DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY)
    expect(resolveClaudeCodeConcurrency(undefined, { CLAUDE_CODE_MAX_CONCURRENCY: "0" })).toBe(
      DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY,
    )
    expect(resolveClaudeCodeConcurrency(undefined, { CLAUDE_CODE_MAX_CONCURRENCY: "nope" })).toBe(
      DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY,
    )
  })
})
