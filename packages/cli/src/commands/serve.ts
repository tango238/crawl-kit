// crawl-kit serve — the viewer HTTP server (routes: /view-model.json, /diff.json, /).
// startViewer() is the reusable primitive (also used by `run`, P2 Task 5); cmdServe()
// is the CLI-facing wrapper that prints URLs and stays alive.

import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, resolve, sep } from "node:path";
import { apiRoutes, readTransactionsRaw } from "@crawl-kit/viewer";

export type StartViewerOptions = {
  port: number;
  host: string;
  /** When set, serve `/` and any GET path from this directory (index.html at `/`,
   *  content-typed .html/.js/.css/.svg/.png, traversal-safe). This is the primary
   *  path (the built viewer SPA, see packages/viewer/public) — takes priority over
   *  the `html` fallback, which only applies when assetsDir is unset. */
  assetsDir?: string;
  /** Optional inline HTML served at `/` when assetsDir is unset (e.g. a minimal
   *  shell for tests). At least one of assetsDir/html must be provided — startViewer
   *  throws a clear error otherwise (no legacy bundled single-page HTML remains, see
   *  P5 Task 7). */
  html?: string;
};

export type Viewer = {
  close(): Promise<void>;
  port: number;
  urls: string[];
};

/** First non-internal IPv4 address — the LAN IP other devices (phones) can reach. */
function lanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Serve `urlPath` from assetsDir if it maps to an existing file underneath it.
 *  Path-traversal-safe: resolves the target and requires it stay within assetsDir
 *  (prefix-checked with a trailing separator so a sibling dir sharing a name prefix
 *  can't slip through, e.g. assetsDir=/x/pub vs /x/pub-evil). */
async function serveAsset(assetsDir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const base = resolve(assetsDir);
  let rel: string;
  try {
    rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  } catch {
    return false; // malformed percent-encoding (e.g. "/%zz") — treat as not found, not a 500
  }
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(base + sep)) return false;
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": ASSET_CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/** Start the viewer HTTP server and resolve once it is listening. Silent — no console output. */
export async function startViewer(opts: StartViewerOptions): Promise<Viewer> {
  const { port, host, html, assetsDir } = opts;
  if (!assetsDir && !html) {
    throw new Error(
      "startViewer: no viewer assets to serve — pass assetsDir (the built viewer, packages/viewer/public " +
        "or dist/viewer-public) or an html fallback. Run 'pnpm --filter @tanago3/crawl-kit build' " +
        "(or 'pnpm -r build') so dist/viewer-public exists, or run from inside the monorepo where " +
        "packages/viewer/public is resolvable.",
    );
  }
  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      // raw ndjson passthrough — NOT in apiRoutes (it's text, not JSON; see viewer's api.ts)
      if (url === "/transactions.jsonl") {
        const body = await readTransactionsRaw();
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
        res.end(body);
        return;
      }
      const route = apiRoutes[url];
      if (route) return sendJson(res, await route());
      if (assetsDir) {
        if (await serveAsset(assetsDir, url, res)) return;
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`error: ${(error as Error).message}`);
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  const urls = [`http://localhost:${actualPort}/`];
  const lan = host !== "127.0.0.1" ? lanAddress() : undefined;
  if (lan) urls.push(`http://${lan}:${actualPort}/`);

  return {
    port: actualPort,
    urls,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cmdServe(args: string[], assetsDir?: string, html?: string): Promise<void> {
  const port = Number(flag(args, "--port") ?? process.env.PORT ?? 4317);
  // bind to all interfaces by default so phones/other devices on the LAN can reach it;
  // pass --host 127.0.0.1 to restrict to this machine only.
  const host = flag(args, "--host") ?? "0.0.0.0";
  const viewer = await startViewer({ port, host, assetsDir, html });
  console.log(`crawl-kit: viewer at http://localhost:${viewer.port}  （ダッシュボード + 4メニュー・リクエスト毎に再構築）`);
  for (const url of viewer.urls) {
    if (!url.startsWith("http://localhost:")) console.log(`  同じネットワークのスマホ等から: ${url.replace(/\/$/, "")}`);
  }
}
