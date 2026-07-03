// packages/viewer/src/server.ts
//
// `pnpm --filter @crawl-kit/viewer dev`
// A dependency-free dev server. The viewer holds NO state of its own — it serves the
// static page and the view-model assembled fresh from data/ on each request (the RDRA
// model + the reconcile diff). Refresh after a reconcile and the view updates.

import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { argv } from "node:process";
import { apiRoutes, readTransactionsRaw } from "./api.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "..", "public");
const PORT = Number(process.env.PORT ?? 4317);

/** Raw behavior API transactions jsonl bridged into data/. Empty string if absent.
 *  Kept as an alias — readTransactionsRaw (api.ts) is now the shared implementation
 *  both servers use; this name stays for existing callers/tests. */
export const readTransactionsJsonl = readTransactionsRaw;

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Serve `urlPath` from PUBLIC_DIR if it maps to an existing file underneath it.
 *  Path-traversal-safe: resolves the target and requires it stay within PUBLIC_DIR
 *  (prefix-checked with a trailing separator so "../public-evil" can't slip through). */
async function serveAsset(urlPath: string, res: ServerResponse): Promise<boolean> {
  let rel: string;
  try {
    rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  } catch {
    return false; // malformed percent-encoding (e.g. "/%zz") — treat as not found, not a 500
  }
  const target = resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) return false;
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": ASSET_CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// Exported (in addition to being auto-started below when run directly) so tests can
// server.listen(0) on an ephemeral port and exercise serveAsset() over real HTTP.
export const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? "/";
    // raw API transactions (ndjson), consumed by the SPA's 通信ログ tab (dynamic full list) —
    // NOT in apiRoutes since it's text, not JSON (see api.ts).
    if (url === "/transactions.jsonl") {
      const body = await readTransactionsRaw();
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      res.end(body);
      return;
    }
    const route = apiRoutes[url];
    if (route) {
      const body = await route();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return;
    }
    if (await serveAsset(url, res)) return;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`viewer error: ${(error as Error).message}`);
  }
});

// Only bind the port when run directly (`tsx src/server.ts`), not when imported (tests).
const isMain = argv[1] ? import.meta.url === pathToFileURL(argv[1]).href : false;
if (isMain) {
  server.listen(PORT, () => {
    console.log(`viewer: http://localhost:${PORT}  （サイドバー「差分 (意図｜構造｜挙動)」タブに統合）`);
  });
}
