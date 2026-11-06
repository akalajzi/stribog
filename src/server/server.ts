// Production server: the built web app plus the JSON API. Binds to localhost by default.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { getNetwork, setup, SignedOutError } from "./provider.ts";
import { createSession, endSession, LoginError, sessionFrom, setSessionCookie, signIn, type Session } from "./session.ts";

const DIST = resolve(import.meta.dirname, "../../dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json" };

/** What the browser needs to know before showing anything: signed in or not, and how to sign in. */
export interface SessionInfo {
  signedIn: boolean;
  kind?: "router" | "demo" | "files";
  user?: string;
  router?: { url: string; encrypted: boolean; identity?: string; version?: string; model?: string };
  /** Shown on the sign-in screen. */
  login?: { address: string; addressFixed: boolean };
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  const route = `${req.method} ${url.pathname}`;
  if (!url.pathname.startsWith("/api/")) return false;
  try {
    // State changes only from this app's own pages: JSON bodies and a same-origin Origin.
    if (req.method === "POST" && !sameOrigin(req)) return send(res, 403, { error: "Cross-site request refused." }), true;
    const s = setup();
    const session = sessionFrom(req);

    if (route === "GET /api/session") {
      const info: SessionInfo = session
        ? { signedIn: true, kind: session.kind, user: session.router?.user, router: session.router && publicRouter(session.router) }
        : s.login
          ? { signedIn: false, login: { address: s.address, addressFixed: s.addressFixed } }
          : { signedIn: true, kind: "files" };
      return send(res, 200, info), true;
    }

    if (route === "POST /api/login") {
      const body = await readJson(req);
      const address = s.addressFixed ? s.address : String(body.address ?? s.address);
      try {
        const router = await signIn(address, String(body.user ?? "").trim(), String(body.password ?? ""));
        endSession(session?.id);
        setSessionCookie(res, createSession("router", router));
        return send(res, 200, { ok: true }), true;
      } catch (err) {
        if (!(err instanceof LoginError)) throw err;
        // Slow down guessing; the router itself has no lockout.
        if (err.status === 401) await new Promise((r) => setTimeout(r, 1000));
        return send(res, err.status, { error: err.message }), true;
      }
    }

    if (route === "POST /api/demo") {
      endSession(session?.id);
      setSessionCookie(res, createSession("demo"));
      return send(res, 200, { ok: true }), true;
    }

    if (route === "POST /api/logout") {
      endSession(session?.id);
      setSessionCookie(res, undefined);
      return send(res, 200, { ok: true }), true;
    }

    if (route === "GET /api/network") {
      if (s.login && !session) return send(res, 401, { error: "Sign in to see the network." }), true;
      try {
        return send(res, 200, await getNetwork(session, url.searchParams.has("refresh"))), true;
      } catch (err) {
        if (!(err instanceof SignedOutError)) throw err;
        endSession(session?.id);
        setSessionCookie(res, undefined);
        return send(res, 401, { error: err.message }), true;
      }
    }
    return send(res, 404, { error: "No such API." }), true;
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) }), true;
  }
}

function publicRouter(r: NonNullable<Session["router"]>): SessionInfo["router"] {
  return { url: r.url, encrypted: r.encrypted, identity: r.identity, version: r.version, model: r.model };
}

function sameOrigin(req: IncomingMessage): boolean {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; browsers always send Origin on POST
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("Request too large.");
  }
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
