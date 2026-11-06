// Production server: the built web app plus the JSON API. Binds to localhost by default.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { getNetwork } from "./provider.ts";

const DIST = resolve(import.meta.dirname, "../../dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json" };

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/api/network" && req.method === "GET") {
    try {
      const payload = await getNetwork(url.searchParams.has("refresh"));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }
  return false;
}

if (import.meta.main ?? process.argv[1]?.endsWith("server.ts")) {
  const port = Number(process.env.PORT ?? 4517);
  const host = process.env.HOST ?? "127.0.0.1";
  createServer(async (req, res) => {
    if (await handleApi(req, res)) return;
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = join(DIST, path === "/" ? "index.html" : path);
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
    if (!existsSync(file)) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("Run `pnpm build` first.");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(port, host, () => console.log(`Stribog on http://${host}:${port}`));
}
