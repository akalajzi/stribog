// Production server: the built web app plus the JSON API. Binds to localhost by default.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { getNetwork, getNetworkForAgent, notesFor, setup, SignedOutError } from "./provider.ts";
import { NotesError } from "./notes.ts";
import { TokenStore } from "./tokens.ts";
import { handleMcp } from "./mcp.ts";
import { deviceActivity } from "./device-activity.ts";
import { ensureRecorder } from "./recorder.ts";
import { rdap } from "./owners.ts";
import { isPrivateIp } from "../core/net.ts";
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
  if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") return false;
  ensureRecorder();
  try {
    const s = setup();
    // An agent token (Authorization: Bearer) or this app's own session cookie.
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const agent = bearer ? tokensFor(s.dataDir).verify(bearer) : undefined;
    if (bearer && !agent) return send(res, 401, { error: "Unknown or revoked agent token." }), true;
    // Cookie-authenticated changes only from this app's own pages.
    if (!agent && req.method !== "GET" && !sameOrigin(req)) return send(res, 403, { error: "Cross-site request refused." }), true;
    const session = agent ? undefined : sessionFrom(req);
    const signedIn = !!agent || !!session || !s.login;

    if (route === "GET /api/session") {
      const info: SessionInfo = session
        ? { signedIn: true, kind: session.kind, user: session.router?.user, router: session.router && publicRouter(session.router) }
        : agent || !s.login
          ? { signedIn: true, kind: "files" }
          : { signedIn: false, login: { address: s.address, addressFixed: s.addressFixed } };
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

    if (!signedIn) return send(res, 401, { error: "Sign in to see the network." }), true;

    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await handleMcp(req, res, body, {
        network: () => (agent ? getNetworkForAgent() : getNetwork(session)),
        notes: notesFor(session?.kind === "demo"),
        activity: (id, hours) => deviceActivity({ session, agent: !!agent, id, hours }),
      });
      return true;
    }

    if (route === "GET /api/network") {
      if (agent) {
        const p = await getNetworkForAgent();
        return p ? send(res, 200, p) : send(res, 503, { error: "Stribog has not read the router yet. Someone needs to sign in to the app once." }), true;
      }
      try {
        return send(res, 200, await getNetwork(session, url.searchParams.has("refresh"))), true;
      } catch (err) {
        if (!(err instanceof SignedOutError)) throw err;
        endSession(session?.id);
        setSessionCookie(res, undefined);
        return send(res, 401, { error: err.message }), true;
      }
    }

    const act = /^\/api\/devices\/([^/]+)\/activity$/.exec(url.pathname);
    if (act && req.method === "GET") {
      const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours")) || 24));
      const a = await deviceActivity({ session, agent: !!agent, id: decodeURIComponent(act[1]!), hours });
      return a ? send(res, 200, a) : send(res, 404, { error: "No such device." }), true;
    }

    // Registry record for one public address: the only lookup that sends an address out, on request.
    if (route === "GET /api/lookup/rdap") {
      const ip = url.searchParams.get("ip") ?? "";
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || isPrivateIp(ip)) return send(res, 400, { error: "Give one public IPv4 address." }), true;
      if (session?.kind === "demo") return send(res, 200, { network: "EXAMPLE", organisation: "Documentation range (RFC 5737): no real owner", link: `https://rdap.org/ip/${ip}` }), true;
      try {
        return send(res, 200, await rdap(ip)), true;
      } catch (err) {
        return send(res, 502, { error: `Could not ask the registry: ${err instanceof Error ? err.message : String(err)}` }), true;
      }
    }

    // ---- notes: same rights for people and agents ----
    if (url.pathname.startsWith("/api/notes")) {
      const notes = notesFor(session?.kind === "demo");
      try {
        if (route === "GET /api/notes") return send(res, 200, notes.get()), true;
        if (route === "GET /api/notes/audit") return send(res, 200, notes.audit(Number(url.searchParams.get("limit")) || 200)), true;
        if (route === "PATCH /api/notes/network") return send(res, 200, notes.updateNetwork(await readJson(req))), true;
        const mac = /^\/api\/notes\/devices\/([^/]+)$/.exec(url.pathname)?.[1];
        if (mac) {
          const m = decodeURIComponent(mac);
          if (req.method === "GET") return send(res, 200, notes.device(m) ?? {}), true;
          if (req.method === "PATCH") return send(res, 200, notes.updateDevice(m, await readJson(req))), true;
          if (req.method === "PUT") return send(res, 200, notes.updateDevice(m, await readJson(req), true)), true;
          if (req.method === "DELETE") return notes.deleteDevice(m), send(res, 200, { ok: true }), true;
        }
      } catch (err) {
        if (err instanceof NotesError) return send(res, 400, { error: err.message }), true;
        throw err;
      }
    }

    // ---- agent tokens: managed by a signed-in person only ----
    if (url.pathname.startsWith("/api/tokens")) {
      if (agent) return send(res, 403, { error: "Agent tokens cannot manage tokens." }), true;
      if (session?.kind === "demo") return send(res, 403, { error: "Sign in to your router to connect an agent; the demo has no tokens." }), true;
      const tokens = tokensFor(s.dataDir);
      if (route === "GET /api/tokens") return send(res, 200, tokens.list()), true;
      if (route === "POST /api/tokens") return send(res, 201, tokens.create(String((await readJson(req)).name ?? ""))), true;
      const id = /^\/api\/tokens\/([\w-]+)$/.exec(url.pathname)?.[1];
      if (id && req.method === "DELETE") return tokens.revoke(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: "No such token." }), true;
    }

    return send(res, 404, { error: "No such API." }), true;
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) }), true;
  }
}

const tokenStores = new Map<string, TokenStore>();
function tokensFor(dir: string): TokenStore {
  let t = tokenStores.get(dir);
  if (!t) tokenStores.set(dir, (t = new TokenStore(join(dir, "tokens.json"))));
  return t;
}

function publicRouter(r: NonNullable<Session["router"]>): SessionInfo["router"] {
  return { url: r.url, encrypted: r.encrypted, identity: r.identity, version: r.version, model: r.model };
}

function sameOrigin(req: IncomingMessage): boolean {
  // A JSON body cannot come from a plain cross-site form; DELETE has no body.
  if (req.method !== "DELETE" && !/^application\/json\b/.test(req.headers["content-type"] ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; browsers always send Origin on POST
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, max = 256 * 1024): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) throw new Error("Request too large.");
  }
  try {
    return JSON.parse(raw || "null") as unknown;
  } catch {
    return undefined;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const v = await readBody(req);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
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
