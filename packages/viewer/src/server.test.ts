import { describe, it, expect, afterEach } from "vitest";
import { readTransactionsJsonl, server } from "./server.js";

describe("readTransactionsJsonl", () => {
  it("returns a string (empty when file absent)", async () => {
    const out = await readTransactionsJsonl();
    expect(typeof out).toBe("string");
  });
});

describe("serveAsset (via the exported http.Server)", () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  async function listen(): Promise<number> {
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  it("returns 404 (not 500) for malformed percent-encoding (/%zz)", async () => {
    const port = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/%zz`);
    expect(res.status).toBe(404);
  });
});
