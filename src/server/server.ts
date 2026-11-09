// Production server: the built web app plus the JSON API. Binds to localhost by default.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { getNetwork, getNetworkForAgent, liveRates, notesFor, setup, SignedOutError, snapshotOf } from "./provider.ts";
import { adviceRequest } from "../core/advice.ts";
import { changeContext } from "../core/change.ts";
import { NotesError } from "./notes.ts";
import { TokenStore } from "./tokens.ts";
import { handleMcp } from "./mcp.ts";
import { deviceActivity } from "./device-activity.ts";
import { internetHistory } from "./internet.ts";
import { ownersNow } from "./live-owners.ts";
import { CannotChange, pause, pausePreview, resume, resumePreview } from "./pause.ts";
import { ChangeFailed, PauseRefused } from "../core/pause.ts";
import { keep, pendingChanges, undo, wifiApply, wifiPreview } from "./changes.ts";
import { WifiRefused, type Security } from "../core/wifi-setup.ts";
import { AuthError } from "../core/rest.ts";
import { ensureRecorder } from "./recorder.ts";
import { rdap } from "./owners.ts";
import { addAdGuard, AdGuardError, adguards, connectAdGuard, dnsHandedOut, removeAdGuard } from "./adguard.ts";
import { isPrivateIp } from "../core/net.ts";
import { createSession, endSession, LoginError, sessionFrom, setSessionCookie, signIn, type Session } from "./session.ts";

const DIST = resolve(import.meta.dirname, "../../dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json" };

/** What the browser needs to know before showing anything: signed in or not, and how to sign in. */
/** Other sources Stribog reads, for Settings. Never includes a password. */
export interface IntegrationsInfo {
  adguard: {
    /** The demo reads a built-in sample instead. */
    sample?: boolean;
    servers: { url: string; user: string; encrypted: boolean; version?: string; error?: string }[];
    /** The DNS servers the router hands out, other than itself: probably the ones to connect, all of them. */
    handedOut: { ip: string; name?: string; address: string; connected: boolean }[];
  };
}

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
  // For a container's health check and a deploy's "is the new version up": no session, no router.
  if (route === "GET /healthz") return send(res, 200, { ok: true, revision: process.env.STRIBOG_REVISION ?? "dev" }), true;
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
        internet: (hours) => internetHistory({ session, agent: !!agent, hours }),
      });
      return true;
    }

    // The whole network's internet traffic by who runs the other end, every few seconds.
    if (route === "GET /api/live/owners") {
      if (!session) return send(res, 200, null), true;
      try {
        return send(res, 200, (await ownersNow(session)) ?? null), true;
      } catch (err) {
        return send(res, 502, { error: err instanceof Error ? err.message : String(err) }), true;
      }
    }

    // Traffic now, every couple of seconds, between full reads (live routers only).
    if (route === "GET /api/live") {
      const r = session && liveRates(session);
      if (!r) return send(res, 200, null), true;
      try {
        return send(res, 200, await r), true;
      } catch (err) {
        return send(res, 502, { error: err instanceof Error ? err.message : String(err) }), true;
      }
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

    // A finding as a request for advice, for a person to hand to an agent (agents use MCP's get_fix_request).
    const req4 = /^\/api\/review\/([^/]+)\/request$/.exec(url.pathname);
    if (req4 && req.method === "GET") {
      const p = agent ? await getNetworkForAgent() : await getNetwork(session);
      const f = p?.analysis.findings.find((x) => x.id === decodeURIComponent(req4[1]!));
      const snap = p && snapshotOf(p);
      if (!p || !f || !snap) return send(res, 404, { error: "No such finding right now." }), true;
      return send(res, 200, { text: adviceRequest({ finding: f, model: p.model, snap, notes: snap.notes }) }), true;
    }

    // What a change to the setup needs from the router's configuration; the page writes the script from it.
    if (route === "GET /api/change") {
      const p = agent ? await getNetworkForAgent() : await getNetwork(session);
      const snap = p && snapshotOf(p);
      if (!p || !snap) return send(res, 404, { error: "Stribog has not read the router yet." }), true;
      return send(res, 200, changeContext(snap, p.model)), true;
    }

    // Accepting a finding: a note like any other, logged, with the same rights for people and agents.
    const acc = /^\/api\/review\/([^/]+)\/accept$/.exec(url.pathname);
    if (acc && (req.method === "PUT" || req.method === "DELETE")) {
      const id = decodeURIComponent(acc[1]!);
      const notes = notesFor(session?.kind === "demo");
      try {
        if (req.method === "DELETE") return notes.reopenFinding(id), send(res, 200, { ok: true }), true;
        const p = agent ? await getNetworkForAgent() : await getNetwork(session);
        const f = p?.analysis.findings.find((x) => x.id === id);
        if (!f || f.severity === "pass") return send(res, 404, { error: "No such finding to accept right now." }), true;
        notes.acceptFinding(id, f.title, (await readJson(req)).reason);
        return send(res, 200, { ok: true }), true;
      } catch (err) {
        if (err instanceof NotesError) return send(res, 400, { error: err.message }), true;
        throw err;
      }
    }

    // Pausing a device's internet: GET shows the exact change, POST makes it and checks it.
    const pz = /^\/api\/devices\/([^/]+)\/(pause|resume)$/.exec(url.pathname);
    if (pz && (req.method === "GET" || req.method === "POST")) {
      if (agent) return send(res, 403, { error: "Only a person signed in to Stribog can change the router." }), true;
      const id = decodeURIComponent(pz[1]!);
      const viewer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
      try {
        // The result without the tables read back: those are for Stribog's own picture.
        const done = ({ ok, steps }: { ok: boolean; steps: unknown }) => ({ ok, steps });
        if (pz[2] === "pause") return send(res, 200, req.method === "GET" ? await pausePreview(session, id, viewer) : done(await pause(session, id, viewer))), true;
        return send(res, 200, req.method === "GET" ? await resumePreview(session, id) : done(await resume(session, id))), true;
      } catch (err) {
        if (err instanceof PauseRefused || err instanceof CannotChange) return send(res, 409, { error: err.message }), true;
        if (err instanceof ChangeFailed) return send(res, 502, { error: err.message, steps: err.steps }), true;
        if (err instanceof AuthError) return send(res, 403, { error: `The router did not let this user change it (${err.message}).` }), true;
        return send(res, 502, { error: `Could not change the router: ${err instanceof Error ? err.message : String(err)}` }), true;
      }
    }

    // Changes with a timed undo: Wi-Fi settings, then keep or undo while the router waits.
    if (route === "GET /api/changes/pending") return send(res, 200, agent ? [] : pendingChanges(session)), true;
    const chg = /^\/api\/changes\/([0-9a-f]+)\/(keep|undo)$/.exec(url.pathname);
    if ((route === "POST /api/wifi/preview" || route === "POST /api/wifi/apply" || (chg && req.method === "POST"))) {
      if (agent) return send(res, 403, { error: "Only a person signed in to Stribog can change the router." }), true;
      try {
        if (chg) return send(res, 200, { steps: await (chg[2] === "keep" ? keep(session, chg[1]!) : undo(session, chg[1]!)) }), true;
        const b = await readJson(req);
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        const edit = { ssid: String(b.ssid ?? ""), name: str(b.name), password: str(b.password), security: (["wpa2", "wpa2-wpa3", "wpa3"] as const).find((x) => x === b.security) as Security | undefined };
        return send(res, 200, route === "POST /api/wifi/preview" ? await wifiPreview(session, edit) : await wifiApply(session, edit)), true;
      } catch (err) {
        if (err instanceof WifiRefused || err instanceof CannotChange) return send(res, 409, { error: err.message }), true;
        if (err instanceof ChangeFailed) return send(res, 502, { error: err.message, steps: err.steps }), true;
        if (err instanceof AuthError) return send(res, 403, { error: `The router did not let this user change it (${err.message}).` }), true;
        return send(res, 502, { error: `Could not change the router: ${err instanceof Error ? err.message : String(err)}` }), true;
      }
    }

    // The internet check over a period: outages, where they were, round trips.
    if (route === "GET /api/internet") {
      const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours")) || 24));
      const h = await internetHistory({ session, agent: !!agent, hours });
      return h ? send(res, 200, h) : send(res, 503, { error: "Stribog has not read the router yet." }), true;
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

    // ---- integrations: other sources, connected by a signed-in person only ----
    if (url.pathname.startsWith("/api/integrations")) {
      if (agent) return send(res, 403, { error: "Agents cannot manage integrations." }), true;
      const demo = session?.kind === "demo";
      if (route === "GET /api/integrations") {
        const list = adguards();
        const m = (await getNetwork(session).catch(() => undefined))?.model;
        const handedOut = m ? dnsHandedOut(m) : [];
        const info: IntegrationsInfo = {
          adguard: demo
            ? { sample: true, servers: [], handedOut: [] }
            : { servers: list.map((a) => ({ url: a.client.login.url, user: a.client.login.user, encrypted: a.client.login.encrypted, version: a.client.login.version, error: a.error })), handedOut },
        };
        return send(res, 200, info), true;
      }
      if (demo) return send(res, 403, { error: "The demo network has a sample AdGuard Home log built in." }), true;
      if (route === "POST /api/integrations/adguard") {
        const body = await readJson(req);
        // "The same user as that server": a replica's password, without the browser ever holding it.
        const like = body.sameAs ? adguards().find((a) => a.client.login.url === body.sameAs)?.client.login : undefined;
        if (body.sameAs && !like) return send(res, 400, { error: "That server is no longer connected." }), true;
        try {
          addAdGuard(await connectAdGuard(String(body.address ?? ""), like?.user ?? String(body.user ?? "").trim(), like?.password ?? String(body.password ?? "")));
          return send(res, 200, { ok: true }), true;
        } catch (err) {
          if (!(err instanceof AdGuardError)) throw err;
          if (err.status === 401) await new Promise((r) => setTimeout(r, 1000));
          return send(res, err.status, { error: err.message }), true;
        }
      }
      if (route === "DELETE /api/integrations/adguard") return removeAdGuard(url.searchParams.get("url") ?? undefined), send(res, 200, { ok: true }), true;
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
