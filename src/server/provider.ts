// Where the network picture comes from: files (exports + state), a saved snapshot, the demo
// network, or the router the user is signed in to.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze, type Analysis } from "../core/analyze.ts";
import { layoutTopology, type Layout } from "../core/layout.ts";
import { expand, readConfig, snapshotFromFiles, type StribogConfig } from "../core/load.ts";
import { buildModel, type NetworkModel } from "../core/model.ts";
import { AuthError, RouterOsRest } from "../core/rest.ts";
import type { Overrides, Snapshot } from "../core/ros.ts";
import { defaultRouterAddress, type RouterLogin, type Session } from "./session.ts";

export interface NetworkPayload {
  model: NetworkModel;
  analysis: Analysis;
  layout: Layout;
  meta: {
    mode: "files" | "live" | "demo";
    sample: boolean;
    error?: string;
    /** Live data that could not be refreshed; `refreshedAt` says how old it is. */
    stale?: boolean;
    configPath?: string;
    overridesPath?: string;
    refreshedAt: string;
  };
}

const ROOT = resolve(import.meta.dirname, "../..");
export const DEMO_CONFIG = resolve(ROOT, "fixtures/demo/stribog.config.json");

/** The config in use: $STRIBOG_CONFIG, ./stribog.config.json, or none. */
export function resolveConfigPath(): string | undefined {
  const env = process.env.STRIBOG_CONFIG;
  if (env) return expand(env);
  const local = resolve(process.cwd(), "stribog.config.json");
  return existsSync(local) ? local : undefined;
}

export interface Setup {
  /** Signing in to a router is required: a config with `router`, or no config at all. */
  login: boolean;
  /** The address to sign in to, and whether the config fixed it. */
  address: string;
  addressFixed: boolean;
  configPath?: string;
  config: StribogConfig;
  base: string;
}

export function setup(): Setup {
  const path = resolveConfigPath();
  if (!path) return { login: true, address: defaultRouterAddress(), addressFixed: false, config: {}, base: process.cwd() };
  const { config, base } = readConfig(path);
  const url = config.router?.url;
  return { login: !!config.router, address: url ?? defaultRouterAddress(), addressFixed: !!url, configPath: path, config, base };
}

export class SignedOutError extends Error {}

type Cached = { at: number; payload: NetworkPayload };
let filesCache: Cached | undefined;
let demoCache: Cached | undefined;

/**
 * The network as the given session sees it. Without a session this reads files only: the
 * config's sources, or the demo when there is no config (the CLI uses this path).
 */
export async function getNetwork(session?: Session, force = false): Promise<NetworkPayload> {
  if (session?.kind === "demo" || (!session && !resolveConfigPath())) {
    demoCache = await cached(demoCache, 2000, force, () => fromFiles(DEMO_CONFIG, "demo"));
    return demoCache.payload;
  }
  const s = setup();
  if (session?.router) return liveNetwork(session, session.router, s, force);
  filesCache = await cached(filesCache, 2000, force, () => {
    const payload = fromFiles(s.configPath!, "files");
    if (s.login) payload.meta.error = "Not signed in to the router, so this is the configuration from files.";
    return payload;
  });
  return filesCache.payload;
}

async function cached(c: Cached | undefined, ttl: number, force: boolean, make: () => NetworkPayload | Promise<NetworkPayload>): Promise<Cached> {
  if (!force && c && Date.now() - c.at < ttl) return c;
  return { at: Date.now(), payload: await make() };
}

function fromFiles(path: string, mode: "files" | "demo"): NetworkPayload {
  const { config, base } = readConfig(path);
  const snap = snapshotFromFiles({ ...config, router: undefined }, base);
  return build(snap, { mode, sample: !!snap.sampleState, configPath: path, overridesPath: config.overrides ? expand(config.overrides, base) : undefined });
}

// One router read at a time per session; a second tab or a quick reload joins the one in flight.
const inFlight = new WeakMap<Session, Promise<NetworkPayload>>();

function liveNetwork(session: Session, login: RouterLogin, s: Setup, force: boolean): Promise<NetworkPayload> {
  const ttl = (s.config.router?.interval ?? 15) * 1000;
  const prev = session.cache as Cached | undefined;
  if (!force && prev && Date.now() - prev.at < ttl) return Promise.resolve(prev.payload);
  const running = inFlight.get(session);
  if (running) return running;
  const p = readLive(session, login, s, prev).finally(() => inFlight.delete(session));
  inFlight.set(session, p);
  return p;
}

async function readLive(session: Session, login: RouterLogin, s: Setup, prev: Cached | undefined): Promise<NetworkPayload> {
  try {
    const snap = await liveSnapshot(login, s);
    if (s.config.debug?.saveSnapshot) writeFileSync(expand(s.config.debug.saveSnapshot, s.base), JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 });
    const payload = build(snap, { mode: "live", sample: false, configPath: s.configPath, overridesPath: s.config.overrides ? expand(s.config.overrides, s.base) : undefined });
    session.cache = { at: Date.now(), payload };
    return payload;
  } catch (err) {
    // A changed password ends the session; anything else keeps the last picture, marked stale.
    if (err instanceof AuthError) throw new SignedOutError("The router no longer accepts the password you signed in with.");
    const error = `Could not read the router: ${err instanceof Error ? err.message : String(err)}`;
    if (prev) return { ...prev.payload, meta: { ...prev.payload.meta, error, stale: true } };
    throw new Error(error);
  }
}

async function liveSnapshot(login: RouterLogin, s: Setup): Promise<Snapshot> {
  const router = await new RouterOsRest({ url: login.url, user: login.user, password: login.password, insecure: login.encrypted }).snapshot();
  // Exports of other devices (access points) still add detail the router cannot see.
  const files = snapshotFromFiles({ ...s.config, sources: (s.config.sources ?? []).filter((x) => x.role !== "router"), snapshot: undefined }, s.base);
  const overrides = s.config.overrides ? (JSON.parse(readFileSync(expand(s.config.overrides, s.base), "utf8")) as Overrides) : undefined;
  return { collectedAt: new Date().toISOString(), devices: [router, ...files.devices], overrides };
}

function build(snap: Snapshot, meta: Omit<NetworkPayload["meta"], "refreshedAt">): NetworkPayload {
  const model = buildModel(snap);
  return { model, analysis: analyze(model, snap), layout: layoutTopology(model), meta: { ...meta, refreshedAt: new Date().toISOString() } };
}
