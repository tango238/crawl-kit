import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startViewer } from "./serve.js";

const here = dirname(fileURLToPath(import.meta.url));
const VIEWER_PUBLIC_DIR = resolve(here, "../../../viewer/public");

describe("startViewer", () => {
  it("serves the html shell and closes cleanly", async () => {
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>ok</html>" });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/`);
      expect(await res.text()).toContain("ok");
      const notFound = await fetch(`http://127.0.0.1:${viewer.port}/nope`);
      expect(notFound.status).toBe(404);
    } finally {
      await viewer.close();
    }
  });

  it("resolves the actual OS-assigned port and includes a localhost url", async () => {
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>ok</html>" });
    try {
      expect(viewer.port).toBeGreaterThan(0);
      expect(viewer.urls).toContain(`http://localhost:${viewer.port}/`);
    } finally {
      await viewer.close();
    }
  });

  it("rejects when the port is already in use", async () => {
    const first = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>ok</html>" });
    try {
      await expect(startViewer({ port: first.port, host: "127.0.0.1", html: "<html>ok</html>" })).rejects.toThrow();
    } finally {
      await first.close();
    }
  });

  it("throws a clear error when neither assetsDir nor html is provided (no legacy HTML fallback remains)", async () => {
    await expect(startViewer({ port: 0, host: "127.0.0.1" })).rejects.toThrow(/assetsDir/);
  });

  it("wires apiRoutes: /view-model.json returns JSON even without assetsDir", async () => {
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>ok</html>" });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/view-model.json`);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(body).toBeTypeOf("object");
    } finally {
      await viewer.close();
    }
  });
});

describe("startViewer with assetsDir", () => {
  async function makeAssetsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ck-serve-assets-"));
    await writeFile(join(dir, "index.html"), "<html>from assetsDir</html>", "utf8");
    await mkdir(join(dir, "js"), { recursive: true });
    await writeFile(join(dir, "js", "app.js"), "console.log('hi');", "utf8");
    return dir;
  }

  it("serves index.html at / with text/html content-type", async () => {
    const assetsDir = await makeAssetsDir();
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>fallback</html>", assetsDir });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/`);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("from assetsDir");
    } finally {
      await viewer.close();
    }
  });

  it("serves a nested .js file with a javascript content-type", async () => {
    const assetsDir = await makeAssetsDir();
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>fallback</html>", assetsDir });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/js/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toContain("console.log");
    } finally {
      await viewer.close();
    }
  });

  it("returns 404 for a path-traversal attempt outside assetsDir", async () => {
    const assetsDir = await makeAssetsDir();
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>fallback</html>", assetsDir });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/../secret`);
      expect(res.status).toBe(404);
    } finally {
      await viewer.close();
    }
  });

  it("returns 404 for an encoded path-traversal attempt (/%2e%2e/secret)", async () => {
    // A real file one level above assetsDir — this exercises the
    // decode-before-resolve guard (decodeURIComponent runs before the
    // startsWith(base + sep) check), not just "the file happens not to exist".
    const parent = await mkdtemp(join(tmpdir(), "ck-serve-parent-"));
    const assetsDir = join(parent, "public");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(join(assetsDir, "index.html"), "<html>from assetsDir</html>", "utf8");
    await writeFile(join(parent, "secret"), "TOP SECRET", "utf8");

    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>fallback</html>", assetsDir });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/%2e%2e/secret`);
      expect(res.status).toBe(404);
    } finally {
      await viewer.close();
    }
  });

  it("returns 404 (not 500) for malformed percent-encoding (/%zz)", async () => {
    const assetsDir = await makeAssetsDir();
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>fallback</html>", assetsDir });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/%zz`);
      expect(res.status).toBe(404);
    } finally {
      await viewer.close();
    }
  });

  it("returns 404 for a missing asset under assetsDir", async () => {
    const assetsDir = await makeAssetsDir();
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>fallback</html>", assetsDir });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/nope.css`);
      expect(res.status).toBe(404);
    } finally {
      await viewer.close();
    }
  });

  it("wires apiRoutes alongside asset serving", async () => {
    const assetsDir = await makeAssetsDir();
    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>fallback</html>", assetsDir });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/diff.json`);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.status).toBe(200);
    } finally {
      await viewer.close();
    }
  });
});

describe("startViewer /api/dashboard.json against a temp workspace", () => {
  const prevCwd = process.cwd();
  afterEach(() => {
    process.chdir(prevCwd);
  });

  it("returns a DashboardModel-shaped JSON body", async () => {
    const root = await mkdtemp(join(tmpdir(), "ck-serve-workspace-"));
    await mkdir(join(root, ".crawl-kit"), { recursive: true });
    await writeFile(join(root, ".crawl-kit", "workspace.yaml"), "repositories: []\n", "utf8");
    await mkdir(join(root, "data"), { recursive: true });
    process.chdir(root);

    const viewer = await startViewer({ port: 0, host: "127.0.0.1", html: "<html>ok</html>" });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/api/dashboard.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { progress: unknown; artifacts: unknown; guidance: unknown };
      expect(body.progress).toBeDefined();
      expect(body.artifacts).toBeDefined();
      expect(body.guidance).toBeDefined();
    } finally {
      await viewer.close();
    }
  });
});

describe("startViewer with the real viewer public/ (SPA shell)", () => {
  it("serves index.html with #view and all five menu labels", async () => {
    const viewer = await startViewer({
      port: 0,
      host: "127.0.0.1",
      html: "<html>fallback</html>",
      assetsDir: VIEWER_PUBLIC_DIR,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${viewer.port}/`);
      const body = await res.text();
      expect(body).toContain('id="view"');
      expect(body).toContain("ダッシュボード");
      expect(body).toContain("intent");
      expect(body).toContain("structure");
      expect(body).toContain("behavior");
      expect(body).toContain("観測マップ");
    } finally {
      await viewer.close();
    }
  });

  it("serves /app.js and /views/dashboard.js as JavaScript", async () => {
    const viewer = await startViewer({
      port: 0,
      host: "127.0.0.1",
      html: "<html>fallback</html>",
      assetsDir: VIEWER_PUBLIC_DIR,
    });
    try {
      const appRes = await fetch(`http://127.0.0.1:${viewer.port}/app.js`);
      expect(appRes.status).toBe(200);
      expect(appRes.headers.get("content-type")).toContain("javascript");

      const dashboardRes = await fetch(`http://127.0.0.1:${viewer.port}/views/dashboard.js`);
      expect(dashboardRes.status).toBe(200);
      expect(dashboardRes.headers.get("content-type")).toContain("javascript");
    } finally {
      await viewer.close();
    }
  });

  it("serves the 8 P5 Task 4 intent/structure view files as JavaScript", async () => {
    const viewer = await startViewer({
      port: 0,
      host: "127.0.0.1",
      html: "<html>fallback</html>",
      assetsDir: VIEWER_PUBLIC_DIR,
    });
    try {
      const files = [
        "intent-events",
        "intent-aggregates",
        "intent-transitions",
        "structure-routes",
        "structure-usecases",
        "structure-entities",
        "structure-er",
        "structure-uc-entity",
      ];
      for (const file of files) {
        const res = await fetch(`http://127.0.0.1:${viewer.port}/views/${file}.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("javascript");
      }
    } finally {
      await viewer.close();
    }
  });

  it("serves the 2 P5 Task 5 behavior view files as JavaScript", async () => {
    const viewer = await startViewer({
      port: 0,
      host: "127.0.0.1",
      html: "<html>fallback</html>",
      assetsDir: VIEWER_PUBLIC_DIR,
    });
    try {
      const files = ["behavior-traffic", "behavior-sitemap"];
      for (const file of files) {
        const res = await fetch(`http://127.0.0.1:${viewer.port}/views/${file}.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("javascript");
      }
    } finally {
      await viewer.close();
    }
  });

  it("serves the 3 P5 Task 6 観測マップ view files as JavaScript", async () => {
    const viewer = await startViewer({
      port: 0,
      host: "127.0.0.1",
      html: "<html>fallback</html>",
      assetsDir: VIEWER_PUBLIC_DIR,
    });
    try {
      const files = ["map-events", "map-transitions", "map-boundary"];
      for (const file of files) {
        const res = await fetch(`http://127.0.0.1:${viewer.port}/views/${file}.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("javascript");
      }
    } finally {
      await viewer.close();
    }
  });
});
