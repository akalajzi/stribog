// Who is signed in. Stribog has no users of its own: it signs in to the router with the router's
// user and password and keeps them in memory for the session only. Nothing here touches the disk.

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthError, NotRouterOsError, RouterOsRest } from "../core/rest.ts";

export interface RouterLogin {
  url: string;
  user: string;
  password: string;
  /** https with a certificate we did not verify (routers ship self-signed ones). */
  encrypted: boolean;
  identity?: string;
  version?: string;
  model?: string;
}

export interface Session {
  id: string;
  kind: "router" | "demo";
  router?: RouterLogin;
  seenAt: number;
  /** Per-session cache of the last network read, owned by the provider. */
  cache?: { at: number; payload: unknown };
}

export const COOKIE = "stribog_session";
const IDLE_MS = 12 * 3600_000;

// On globalThis so Vite's module reloads in development do not sign everyone out.
const store: Map<string, Session> = ((globalThis as { __stribogSessions?: Map<string, Session> }).__stribogSessions ??= new Map());

export function createSession(kind: Session["kind"], router?: RouterLogin): Session {
  const s: Session = { id: randomBytes(32).toString("base64url"), kind, router, seenAt: Date.now() };
  store.set(s.id, s);
  return s;
}

export function endSession(id: string | undefined) {
  if (id) store.delete(id);
}

export function sessionFrom(req: IncomingMessage): Session | undefined {
  const id = cookie(req, COOKIE);
  const s = id ? store.get(id) : undefined;
  if (!s) return undefined;
  if (Date.now() - s.seenAt > IDLE_MS) {
    store.delete(s.id);
    return undefined;
  }
  s.seenAt = Date.now();
  return s;
}

/** Still signed in: present and not idle for too long. Does not count as activity. */
export function isAlive(s: Session): boolean {
  return store.get(s.id) === s && Date.now() - s.seenAt <= IDLE_MS;
}

export function setSessionCookie(res: ServerResponse, s: Session | undefined) {
  res.setHeader("set-cookie", s ? `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict` : `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

// ---- signing in -----------------------------------------------------------------

export class LoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** `192.168.88.1` → https then http; an explicit scheme is used as given. Paths are dropped. */
export function candidateUrls(address: string): string[] {
  const a = address.trim();
  if (!a) return [];
  const m = /^(https?):\/\/([^/?#]+)/i.exec(a);
  if (m) return [`${m[1]!.toLowerCase()}://${m[2]}`];
  const host = a.split(/[/?#]/)[0]!;
  return [`https://${host}`, `http://${host}`];
}

/**
 * Sign in to the router: try each candidate URL, keep the first that answers as RouterOS.
 * A refused login stops at once, so a wrong password is never retried over plain http.
 */
export async function signIn(address: string, user: string, password: string, fetchImpl?: typeof fetch): Promise<RouterLogin> {
  const urls = candidateUrls(address);
  if (!urls.length) throw new LoginError("Enter the router's address.", 400);
  if (!user) throw new LoginError("Enter a user name.", 400);
  let notRouter = false;
  for (const url of urls) {
    const encrypted = url.startsWith("https://");
    const rest = new RouterOsRest({ url, user, password, insecure: encrypted, timeoutMs: 5000, fetchImpl });
    try {
      const info = await rest.probe();
      return { url, user, password, encrypted, ...info };
    } catch (err) {
      if (err instanceof AuthError) throw new LoginError("The router did not accept that user name and password.", 401);
      if (err instanceof NotRouterOsError) notRouter = true;
      // Anything else (refused, timed out, TLS) means try the next address.
    }
  }
  throw new LoginError(
    notRouter
      ? `Something answers at ${address.trim()}, but not as a RouterOS 7 router. Stribog needs RouterOS 7.9 or newer with its web service on.`
      : `Could not reach a router at ${address.trim()}. Check the address, and that the router's web service is on (the one WebFig uses).`,
    502,
  );
}

/** Best guess for the router: this machine's default gateway, else the MikroTik factory address. */
export function defaultRouterAddress(): string {
  try {
    // Linux: the default route in /proc/net/route, gateway as little-endian hex.
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const [, dest, gw] = line.trim().split(/\s+/);
      if (dest === "00000000" && gw && gw !== "00000000") return (gw.match(/../g) ?? []).reverse().map((h) => parseInt(h, 16)).join(".");
    }
  } catch {}
  try {
    // macOS and the BSDs.
    const out = execFileSync("route", ["-n", "get", "default"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const gw = /gateway:\s*(\S+)/.exec(out)?.[1];
    if (gw && /^\d+\.\d+\.\d+\.\d+$/.test(gw)) return gw;
  } catch {}
  return "192.168.88.1";
}
