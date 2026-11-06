// Where the network picture comes from: files (exports + state), a saved snapshot, the demo
// network, or the router the user is signed in to.

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyze, type Analysis } from "../core/analyze.ts";
import { layoutTopology, type Layout } from "../core/layout.ts";
import { expand, readConfig, snapshotFromFiles, type StribogConfig } from "../core/load.ts";
import { buildModel, type NetworkModel } from "../core/model.ts";
import { AuthError, RouterOsRest } from "../core/rest.ts";
import type { Snapshot } from "../core/ros.ts";
import { dataDir, NotesStore } from "./notes.ts";
import { defaultRouterAddress, isAlive, type RouterLogin, type Session } from "./session.ts";

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
  /** Notes, the change log and agent tokens live here. */
  dataDir: string;
}

export function setup(): Setup {
  const path = resolveConfigPath();
  if (!path) return { login: true, address: defaultRouterAddress(), addressFixed: false, config: {}, base: process.cwd(), dataDir: dataDir() };
  const { config, base } = readConfig(path);
  const url = config.router?.url;
  return { login: !!config.router, address: url ?? defaultRouterAddress(), addressFixed: !!url, configPath: path, config, base, dataDir: dataDir(config.dataDir && expand(config.dataDir, base)) };
}

export class SignedOutError extends Error {}

// ---- notes ------------------------------------------------------------------------

const stores = new Map<string, NotesStore>();

/**
 * The notes in use. The demo uses its shipped notes and keeps edits in memory; everything else
 * uses the config's `notes` file or the data directory.
 */
export function notesFor(demo: boolean): NotesStore {
  if (demo) {
    const { config, base } = readConfig(DEMO_CONFIG);
    return storeAt(expand(config.notes!, base), undefined, false);
  }
  const s = setup();
  if (s.config.notes) return storeAt(expand(s.config.notes, s.base), join(s.dataDir, "audit.jsonl"));
  return storeAt(join(s.dataDir, "notes.json"), join(s.dataDir, "audit.jsonl"));
}

function storeAt(path: string, audit: string | undefined, persist = true): NotesStore {
  let st = stores.get(path);
  if (!st) stores.set(path, (st = new NotesStore(path, audit, persist)));
  return st;
}

// ---- network ------------------------------------------------------------------------

/** Router data is cached as read; the payload is rebuilt whenever the notes change. */
type Cached = { at: number; snap: Snapshot; meta: Omit<NetworkPayload["meta"], "refreshedAt">; payload: NetworkPayload; notes: unknown };
let filesCache: Cached | undefined;
let demoCache: Cached | undefined;
/** The router session that read most recently, so an agent can see the network too. */
let lastLive: Session | undefined;

/**
 * The network as the given session sees it. Without a session this reads files only: the
 * config's sources, or the demo when there is no config (the CLI uses this path).
 */
export async function getNetwork(session?: Session, force = false): Promise<NetworkPayload> {
  const demo = session?.kind === "demo" || (!session && !resolveConfigPath());
  const notes = notesFor(demo).get();
  if (demo) {
    if (force || !demoCache || Date.now() - demoCache.at > 2000) demoCache = fromFiles(DEMO_CONFIG, "demo");
    return withNotes(demoCache, notes);
  }
  const s = setup();
  if (session?.router) return liveNetwork(session, session.router, s, force);
  if (force || !filesCache || Date.now() - filesCache.at > 2000) {
    filesCache = fromFiles(s.configPath!, "files");
    if (s.login) filesCache.meta.error = "Not signed in to the router, so this is the configuration from files.";
  }
  return withNotes(filesCache, notes);
}

/**
 * What an agent sees: a fresh read through the most recent signed-in session while it lasts,
 * else that session's last picture (marked stale), else nothing.
 */
export async function getNetworkForAgent(): Promise<NetworkPayload | undefined> {
  const s = setup();
  if (!s.login) return getNetwork();
  if (lastLive && isAlive(lastLive) && lastLive.router) return liveNetwork(lastLive, lastLive.router, s, false, false);
  const prev = lastLive?.cache as Cached | undefined;
  if (!prev) return undefined;
  const p = withNotes(prev, notesFor(false).get());
  return { ...p, meta: { ...p.meta, stale: true, error: "Nobody is signed in to Stribog right now, so this is the last picture it read." } };
}

function withNotes(c: Cached, notes: unknown): NetworkPayload {
  if (c.notes !== notes) {
    c.payload = build({ ...c.snap, notes: notes as Snapshot["notes"] }, c.meta);
    c.notes = notes;
  }
  return c.payload;
}

function fromFiles(path: string, mode: "files" | "demo"): Cached {
  const { config, base } = readConfig(path);
  const snap = snapshotFromFiles({ ...config, router: undefined, notes: undefined }, base);
  const meta = { mode, sample: !!snap.sampleState, configPath: path };
  return { at: Date.now(), snap, meta, payload: undefined as unknown as NetworkPayload, notes: Symbol() };
}

// One router read at a time per session; a second tab or a quick reload joins the one in flight.
const inFlight = new WeakMap<Session, Promise<NetworkPayload>>();

function liveNetwork(session: Session, login: RouterLogin, s: Setup, force: boolean, touch = true): Promise<NetworkPayload> {
  const ttl = (s.config.router?.interval ?? 15) * 1000;
  const prev = session.cache as Cached | undefined;
  const notes = notesFor(false).get();
  if (!force && prev && Date.now() - prev.at < ttl) return Promise.resolve(withNotes(prev, notes));
  const running = inFlight.get(session);
  if (running) return running;
  const p = readLive(session, login, s, prev, touch).finally(() => inFlight.delete(session));
  inFlight.set(session, p);
  return p;
}

async function readLive(session: Session, login: RouterLogin, s: Setup, prev: Cached | undefined, touch: boolean): Promise<NetworkPayload> {
  try {
    const snap = await liveSnapshot(login, s);
    if (s.config.debug?.saveSnapshot) writeFileSync(expand(s.config.debug.saveSnapshot, s.base), JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 });
    const c: Cached = { at: Date.now(), snap, meta: { mode: "live", sample: false, configPath: s.configPath }, payload: undefined as unknown as NetworkPayload, notes: Symbol() };
    session.cache = c;
    if (touch) lastLive = session;
    return withNotes(c, notesFor(false).get());
  } catch (err) {
    // A changed password ends the session; anything else keeps the last picture, marked stale.
    if (err instanceof AuthError) throw new SignedOutError("The router no longer accepts the password you signed in with.");
    const error = `Could not read the router: ${err instanceof Error ? err.message : String(err)}`;
    if (prev) {
      const p = withNotes(prev, notesFor(false).get());
      return { ...p, meta: { ...p.meta, error, stale: true } };
    }
    throw new Error(error);
  }
}

async function liveSnapshot(login: RouterLogin, s: Setup): Promise<Snapshot> {
  const router = await new RouterOsRest({ url: login.url, user: login.user, password: login.password, insecure: login.encrypted }).snapshot();
  // Exports of other devices (access points), if configured, add detail the router cannot see.
  const files = snapshotFromFiles({ ...s.config, sources: (s.config.sources ?? []).filter((x) => x.role !== "router"), snapshot: undefined, notes: undefined }, s.base);
  return { collectedAt: new Date().toISOString(), devices: [router, ...files.devices] };
}

function build(snap: Snapshot, meta: Omit<NetworkPayload["meta"], "refreshedAt">): NetworkPayload {
  const model = buildModel(snap);
  return { model, analysis: analyze(model, snap), layout: layoutTopology(model), meta: { ...meta, refreshedAt: new Date().toISOString() } };
}
