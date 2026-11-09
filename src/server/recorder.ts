// Records device history and the internet check once a minute while Stribog holds a router
// login: from the first sign-in until someone signs out, the router refuses the password, or
// Stribog restarts. It reads through that login, which stays in memory.

import { flowsFor, namesByAddress, type Flow } from "../core/activity.ts";
import { connectionsOf, linkCounters } from "../core/model.ts";
import { fullLinks } from "../core/capacity.ts";
import { RouterOsRest } from "../core/rest.ts";
import type { RosRecord } from "../core/ros.ts";
import { HistoryStore } from "./history.ts";
import { ratesNow, setRates } from "./rates.ts";
import { recentNames, withNames } from "./adguard.ts";
import { getNetworkForAgent, liveSession, routerChanged, setup, snapshotOf, type NetworkPayload } from "./provider.ts";
import { PINGS, PUBLIC_TARGETS, pingResult, sampleOf, type NetSample } from "../core/internet.ts";
import { join } from "node:path";

const EVERY_MS = 60_000;
/** How often the router is asked to check for a newer RouterOS. */
const UPDATE_CHECK_MS = 24 * 3600_000;

interface State {
  timer: ReturnType<typeof setInterval>;
  /** Byte counters per tracked connection at the last tick, to record only what moved since. */
  prev: Map<string, { orig: number; repl: number }>;
  lastPrune: number;
  lastTick?: number;
  /** Per gateway address: did it answer pings while the internet worked (some provider boxes never do). */
  gatewayAnswers: Map<string, boolean>;
  lastUpdateCheck?: number;
}

// On globalThis so Vite's module reloads in development keep one recorder, not one per reload.
const G = globalThis as { __stribogRecorder?: State; __stribogTick?: () => Promise<void> };

export function historyFor(dataDir: string) {
  return new HistoryStore(join(dataDir, "history"));
}

export function ensureRecorder() {
  // The timer calls whatever tick() is current, so code reloaded in development takes over.
  G.__stribogTick = () => tick();
  if (G.__stribogRecorder) return;
  const timer = setInterval(() => void G.__stribogTick?.().catch(() => {}), EVERY_MS);
  timer.unref?.();
  G.__stribogRecorder = { timer, prev: new Map(), lastPrune: 0, gatewayAnswers: new Map() };
}

export function recorderActive(): boolean {
  return !!liveSession();
}

/** One sample of every device, plus the bytes each moved to whom since the last tick. */
export async function tick(now = Date.now()) {
  const st = G.__stribogRecorder;
  const session = liveSession();
  if (!st || !session?.router) return;
  const store = historyFor(setup().dataDir);
  const payload = await getNetworkForAgent().catch(() => undefined);
  // A router that does not answer is worth a line too: it is often why the internet is gone.
  if (!payload || payload.meta.stale) {
    if (liveSession()) store.appendInternet({ t: now, s: "unread", w: "router" });
    return;
  }

  const r = session.router;
  const rest = new RouterOsRest({ url: r.url, user: r.user, password: r.password, insecure: r.encrypted, timeoutMs: 15_000 });
  const [conns, dns, net] = await Promise.all([
    rest.connections(),
    rest.dnsCache().catch(() => [] as RosRecord[]),
    checkInternet(rest, payload, st.gatewayAnswers, now).catch(() => undefined),
  ]);
  if (net) store.appendInternet(net);
  // Once a day (and soon after Stribog starts), the router checks for a newer RouterOS.
  if (!st.lastUpdateCheck || now - st.lastUpdateCheck > UPDATE_CHECK_MS) {
    st.lastUpdateCheck = now;
    const pkg = await rest.checkForUpdates().catch(() => undefined);
    if (pkg) routerChanged(session, { "/system/package/update": [pkg] });
  }
  const moved = deltas(conns, st.prev);
  const names = namesByAddress(dns);
  // Names each device was given by AdGuard Home, when connected: the router never sees those lookups.
  const asked = await recentNames(now);
  const byMac = new Map<string, Flow[]>();
  // Kept per connection (MAC): a machine's connections are grouped when read, so a changed grouping is never baked in.
  for (const l of payload.model.devices.flatMap(connectionsOf)) {
    if (!l.mac || !l.ip) continue;
    const flows = flowsFor(l.ip, moved, withNames(names, asked(l.ip)), payload.model).filter((f) => f.down + f.up > 0);
    if (flows.length) byMac.set(l.mac, flows);
  }
  store.addTalks(now, byMac);
  // Per-connection rates over the interval; the first tick has no interval (everything a
  // connection ever moved would count as now).
  const dt = st.lastTick ? (now - st.lastTick) / 1000 : 0;
  if (dt > 0 && dt < 180) {
    const rates = new Map<string, { downBps: number; upBps: number }>();
    for (const l of payload.model.devices.flatMap(connectionsOf)) {
      const fl = byMac.get(l.mac) ?? [];
      rates.set(l.mac, { downBps: Math.round((fl.reduce((t, f) => t + f.down, 0) * 8) / dt), upBps: Math.round((fl.reduce((t, f) => t + f.up, 0) * 8) / dt) });
    }
    setRates({ at: now, byMac: rates });
  }
  store.appendSamples(now, samplesOf(payload, ratesNow(now)?.byMac));
  // Links at their limit this minute, for the review's "where the network runs out".
  store.appendFull(now, fullLinks(payload.model));
  st.lastTick = now;
  if (now - st.lastPrune > 6 * 3600_000) {
    store.prune(now);
    st.lastPrune = now;
  }
}

/**
 * One minute of the internet check: the router pings its provider's gateway and the public
 * addresses, and the answers (with the WAN's link and address) say whether the internet is up
 * and where it stops. Undefined when the router would not ping at all (a user without `test`).
 */
export async function checkInternet(rest: RouterOsRest, p: NetworkPayload, gatewayAnswers: Map<string, boolean>, t: number): Promise<NetSample | undefined> {
  const { wan } = p.model;
  const gw = wan.gateway;
  const [g, ...targets] = await Promise.all([
    gw ? rest.ping(gw, PINGS).then(pingResult) : Promise.resolve(undefined),
    ...PUBLIC_TARGETS.map((a) => rest.ping(a, PINGS).then(pingResult)),
  ]);
  if (!targets.some((x) => x.sent)) return undefined;
  const iface = wan.iface ? snapshotOf(p)?.devices[0]?.state?.["/interface"]?.find((i) => i.name === wan.iface) : undefined;
  const sample = sampleOf(t, {
    linkUp: iface ? iface.running === "true" : undefined,
    address: wan.type === "dhcp" ? (wan.address ?? null) : undefined,
    gateway: g,
    gatewayAnswers: gw ? gatewayAnswers.get(gw) : undefined,
    targets,
  });
  // Learn, while the internet works, whether this gateway answers pings at all.
  if (gw && g?.sent && sample.s === "up") gatewayAnswers.set(gw, g.received > 0);
  return sample;
}

/**
 * Per connection: online, traffic now (down, up) and Wi-Fi signal. Traffic comes from the
 * router's counter of the link, else from what the connection table moved (`measured`).
 */
export function samplesOf(p: NetworkPayload, measured?: Map<string, { downBps: number; upBps: number }>): Record<string, [0 | 1, number | null, number | null, number | null]> {
  const out: Record<string, [0 | 1, number | null, number | null, number | null]> = {};
  const { model: m } = p;
  for (const l of m.devices.flatMap(connectionsOf)) {
    const c = linkCounters(m, l) ?? measured?.get(l.mac);
    out[l.mac] = [l.status === "online" ? 1 : 0, c?.downBps ?? null, c?.upBps ?? null, l.via?.signal ?? null];
  }
  return out;
}

/** The connection table with byte counters replaced by what moved since the last call. */
export function deltas(conns: RosRecord[], prev: Map<string, { orig: number; repl: number }>): RosRecord[] {
  const next = new Map<string, { orig: number; repl: number }>();
  const out: RosRecord[] = [];
  for (const c of conns) {
    const key = `${c[".id"] ?? ""}|${c["src-address"]}|${c["dst-address"]}|${c.protocol}`;
    const orig = Number(c["orig-bytes"] ?? 0) || 0;
    const repl = Number(c["repl-bytes"] ?? 0) || 0;
    const p = prev.get(key);
    // A counter that went down belongs to a new connection that reused the id.
    const dOrig = p && orig >= p.orig ? orig - p.orig : orig;
    const dRepl = p && repl >= p.repl ? repl - p.repl : repl;
    next.set(key, { orig, repl });
    if (dOrig || dRepl) out.push({ ...c, "orig-bytes": String(dOrig), "repl-bytes": String(dRepl) });
  }
  prev.clear();
  for (const [k, v] of next) prev.set(k, v);
  return out;
}
