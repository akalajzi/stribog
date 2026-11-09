// Where the network picture comes from: files (exports + state), a saved snapshot, the demo
// network, or the router the user is signed in to.

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyze, type Analysis } from "../core/analyze.ts";
import { layoutTopology, type Layout } from "../core/layout.ts";
import { expand, readConfig, snapshotFromFiles, type StribogConfig } from "../core/load.ts";
import { buildModel, connectionsOf, linkCounters, type NetworkModel } from "../core/model.ts";
import { AuthError, CONFIG_PATHS, RouterOsRest, type ReadPlan } from "../core/rest.ts";
import type { RosRecord, Snapshot } from "../core/ros.ts";
import type { LiveRates } from "../core/live.ts";
import { dataDir, NotesStore } from "./notes.ts";
import { ratesNow } from "./rates.ts";
import { HistoryStore } from "./history.ts";
import { vendorDb } from "./vendors.ts";
import { markNew } from "../core/newdevices.ts";
import { demoSeen, readSeen, seenFile } from "./seen.ts";
import { canRead, defaultRouterAddress, type RouterLogin, type Session } from "./session.ts";

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
type Cached = { at: number; snap: Snapshot; meta: Omit<NetworkPayload["meta"], "refreshedAt">; payload: NetworkPayload; notes: unknown; configAt?: number; slowAt?: number };

/** Configuration changes when someone changes it: read it this often, at sign-in and on Reload. */
const CONFIG_EVERY = 5 * 60_000;
/** Neighbours, radio channels, access points joining: about once a minute. */
const SLOW_EVERY = 60_000;
let filesCache: Cached | undefined;
let demoCache: Cached | undefined;
/** The router session that read most recently, so agents and the recorder can see the network too. On globalThis so it survives Vite's module reloads. */
const LIVE = globalThis as { __stribogLastLive?: Session; __stribogSavedAt?: number };

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
 * The most recent signed-in router session: agents and the recorder read through its login,
 * also after the browser session went idle, until someone signs out or the password is refused.
 */
export function liveSession(): Session | undefined {
  const l = LIVE.__stribogLastLive;
  return l && canRead(l) ? l : undefined;
}

/** The router state in the files in use (a saved snapshot can carry its connection table). */
export function filesState(): Record<string, import("../core/ros.ts").RosRecord[]> | undefined {
  return filesCache?.snap.devices.find((d) => d.role === "router")?.state;
}

/** The demo's own router state (its connection table, DNS cache), for activity in the demo. */
export function demoState(): Record<string, import("../core/ros.ts").RosRecord[]> | undefined {
  demoCache ??= fromFiles(DEMO_CONFIG, "demo");
  return demoCache.snap.devices.find((d) => d.role === "router")?.state;
}

/**
 * What an agent sees: a fresh read through the most recent signed-in session while it lasts,
 * else that session's last picture (marked stale), else nothing.
 */
export async function getNetworkForAgent(): Promise<NetworkPayload | undefined> {
  const s = setup();
  if (!s.login) return getNetwork();
  const live = liveSession();
  if (live?.router) return liveNetwork(live, live.router, s, false, false);
  const prev = LIVE.__stribogLastLive?.cache as Cached | undefined;
  if (!prev) return undefined;
  const p = withNotes(prev, notesFor(false).get());
  return { ...p, meta: { ...p.meta, stale: true, error: "Nobody has signed in to Stribog since it last signed out or restarted, so this is the last picture it read." } };
}

function withNotes(c: Cached, notes: unknown): NetworkPayload {
  if (c.notes !== notes) {
    c.payload = build({ ...c.snap, notes: notes as Snapshot["notes"] }, c.meta);
    c.notes = notes;
  }
  return c.payload;
}

/** Menus changed on the demo's router (pausing a device), kept in memory like the demo's notes. */
const DEMO_MENUS: Record<string, RosRecord[]> = {};

/** Change menus of the demo's router (in memory, like the demo's notes). */
export function setDemoMenus(tables: Record<string, RosRecord[]>) {
  Object.assign(DEMO_MENUS, tables);
  demoCache = undefined;
}

/** A menu of the demo's router as it stands, changes included. */
export function demoMenu(path: string): RosRecord[] | undefined {
  demoCache ??= fromFiles(DEMO_CONFIG, "demo");
  return demoCache.snap.devices.find((d) => d.role === "router")?.config.menus[path];
}

/**
 * After a change to the router: the tables as read back replace Stribog's copy, so the change
 * shows at once instead of with the next configuration read.
 */
export function routerChanged(session: Session, tables: Record<string, RosRecord[]>) {
  const known = (p: string) => CONFIG_PATHS.includes(p);
  if (session.kind === "demo") return setDemoMenus(Object.fromEntries(Object.entries(tables).filter(([p]) => known(p))));
  const c = session.cache as Cached | undefined;
  const router = c?.snap.devices.find((d) => d.role === "router");
  if (!c || !router) return;
  for (const [p, rows] of Object.entries(tables)) if (known(p)) router.config.menus[p] = rows;
  c.notes = Symbol();
}

function fromFiles(path: string, mode: "files" | "demo"): Cached {
  const { config, base } = readConfig(path);
  const snap = snapshotFromFiles({ ...config, router: undefined, notes: undefined }, base);
  const router = snap.devices.find((d) => d.role === "router");
  if (mode === "demo" && router) Object.assign(router.config.menus, DEMO_MENUS);
  const meta = { mode, sample: !!snap.sampleState, configPath: path };
  return { at: Date.now(), snap, meta, payload: undefined as unknown as NetworkPayload, notes: Symbol() };
}

/**
 * Connections the router has no counter for get the traffic the recorder measured in the
 * connection table over the last minute, marked as such.
 */
function withMeasuredRates(m: NetworkModel) {
  const r = ratesNow();
  if (!r) return;
  for (const l of m.devices.flatMap(connectionsOf)) {
    if (!l.via || linkCounters(m, l)) continue;
    const rate = r.byMac.get(l.mac);
    if (!rate) continue;
    l.via.downBps = rate.downBps;
    l.via.upBps = rate.upBps;
    l.via.measured = "connections";
  }
}

/**
 * Traffic now, between full reads: three small calls instead of the whole router. One read at a
 * time per session, reused for a second, so several tabs cost the router the same as one.
 */
const liveInFlight = new WeakMap<Session, { at: number; p: Promise<LiveRates> }>();
export function liveRates(session: Session): Promise<LiveRates> | undefined {
  const login = session.router;
  const snap = (session.cache as Cached | undefined)?.snap;
  if (!login || !snap) return undefined;
  const prev = liveInFlight.get(session);
  if (prev && Date.now() - prev.at < 1500) return prev.p;
  const ports = (snap.devices[0]?.config.menus["/interface/ethernet"] ?? []).map((e) => e.name ?? "").filter(Boolean);
  const p = new RouterOsRest({ url: login.url, user: login.user, password: login.password, insecure: login.encrypted }).rates(ports);
  liveInFlight.set(session, { at: Date.now(), p });
  return p;
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
  const p = readLive(session, login, s, prev, touch, force).finally(() => inFlight.delete(session));
  inFlight.set(session, p);
  return p;
}

async function readLive(session: Session, login: RouterLogin, s: Setup, prev: Cached | undefined, touch: boolean, force: boolean): Promise<NetworkPayload> {
  try {
    // Each refresh reads who is connected; the configuration and slow state only when due.
    const now = Date.now();
    const config = force || !prev?.configAt || now - prev.configAt > CONFIG_EVERY;
    const slow = config || !prev?.slowAt || now - prev.slowAt > SLOW_EVERY;
    const snap = await liveSnapshot(login, s, { reuse: prev?.snap.devices.find((d) => d.role === "router"), config, slow });
    // Development snapshots are big (with the connection table): at most one a minute.
    if (s.config.debug?.saveSnapshot && Date.now() - (LIVE.__stribogSavedAt ?? 0) > 60_000) {
      LIVE.__stribogSavedAt = Date.now();
      // The development snapshot also keeps the connection table and DNS cache, read on demand otherwise.
      const rest = new RouterOsRest({ url: login.url, user: login.user, password: login.password, insecure: login.encrypted });
      const [conns, dns] = await Promise.all([rest.connections().catch(() => []), rest.dnsCache().catch(() => [])]);
      const st = snap.devices[0]!.state ?? {};
      const saved = { ...snap, devices: [{ ...snap.devices[0]!, state: { ...st, "/ip/firewall/connection": conns, "/ip/dns/cache": dns } }, ...snap.devices.slice(1)] };
      writeFileSync(expand(s.config.debug.saveSnapshot, s.base), JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
    }
    const c: Cached = {
      at: Date.now(),
      snap,
      meta: { mode: "live", sample: false, configPath: s.configPath },
      payload: undefined as unknown as NetworkPayload,
      notes: Symbol(),
      configAt: config ? now : prev?.configAt,
      slowAt: slow ? now : prev?.slowAt,
    };
    session.cache = c;
    if (touch) LIVE.__stribogLastLive = session;
    return withNotes(c, notesFor(false).get());
  } catch (err) {
    // A changed password ends the session (and the recording through it); anything else keeps
    // the last picture, marked stale.
    if (err instanceof AuthError) {
      session.ended = true;
      throw new SignedOutError("The router no longer accepts the password you signed in with.");
    }
    const error = `Could not read the router: ${err instanceof Error ? err.message : String(err)}`;
    if (prev) {
      const p = withNotes(prev, notesFor(false).get());
      return { ...p, meta: { ...p.meta, error, stale: true } };
    }
    throw new Error(error);
  }
}

async function liveSnapshot(login: RouterLogin, s: Setup, plan: ReadPlan): Promise<Snapshot> {
  const router = await new RouterOsRest({ url: login.url, user: login.user, password: login.password, insecure: login.encrypted }).snapshot(plan);
  // Exports of other devices (access points), if configured, add detail the router cannot see.
  const files = snapshotFromFiles({ ...s.config, sources: (s.config.sources ?? []).filter((x) => x.role !== "router"), snapshot: undefined, notes: undefined }, s.base);
  return { collectedAt: new Date().toISOString(), devices: [router, ...files.devices] };
}

/** What the recorder saw over the last week, for the review's checks over time. */
function recorded(days = 7) {
  const now = Date.now();
  return { full: new HistoryStore(join(setup().dataDir, "history")).fullLinks(now - days * 86_400_000, now), days };
}

/** The router data each payload was built from: advice on a finding shows its configuration. */
const SNAPS = new WeakMap<NetworkModel, Snapshot>();
export function snapshotOf(p: NetworkPayload): Snapshot | undefined {
  return SNAPS.get(p.model);
}

function build(snap: Snapshot, meta: Omit<NetworkPayload["meta"], "refreshedAt">): NetworkPayload {
  // Makers from the IEEE registry for real networks; the demo's addresses are documentation ones.
  const model = buildModel(snap, { vendors: meta.mode === "demo" ? undefined : vendorDb(setup().dataDir)?.lookup });
  if (meta.mode === "live") withMeasuredRates(model);
  // New devices: from what the recorder saw (the demo ships its own record).
  if (meta.mode !== "files") markNew(model, meta.mode === "demo" ? demoSeen() : readSeen(seenFile(setup().dataDir)), snap.notes?.devices);
  const payload: NetworkPayload = { model, analysis: analyze(model, snap, meta.mode === "demo" ? {} : recorded()), layout: layoutTopology(model), meta: { ...meta, refreshedAt: new Date().toISOString() } };
  SNAPS.set(model, snap);
  return payload;
}
