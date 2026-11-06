// Records device history once a minute while a router session is alive (someone signed in
// within the last 12 hours). It reads through that session's credentials, which stay in memory.

import { flowsFor, namesByAddress, type Flow } from "../core/activity.ts";
import { RouterOsRest } from "../core/rest.ts";
import type { RosRecord } from "../core/ros.ts";
import { HistoryStore } from "./history.ts";
import { getNetworkForAgent, liveSession, setup, type NetworkPayload } from "./provider.ts";
import { join } from "node:path";

const EVERY_MS = 60_000;

interface State {
  timer: ReturnType<typeof setInterval>;
  /** Byte counters per tracked connection at the last tick, to record only what moved since. */
  prev: Map<string, { orig: number; repl: number }>;
  lastPrune: number;
  lastTick?: number;
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
  G.__stribogRecorder = { timer, prev: new Map(), lastPrune: 0 };
}

export function recorderActive(): boolean {
  return !!liveSession();
}

/** One sample of every device, plus the bytes each moved to whom since the last tick. */
export async function tick(now = Date.now()) {
  const st = G.__stribogRecorder;
  const session = liveSession();
  if (!st || !session?.router) return;
  const payload = await getNetworkForAgent();
  if (!payload || payload.meta.stale) return;
  const store = historyFor(setup().dataDir);
  store.appendSamples(now, samplesOf(payload));

  const r = session.router;
  const rest = new RouterOsRest({ url: r.url, user: r.user, password: r.password, insecure: r.encrypted });
  const [conns, dns] = await Promise.all([rest.connections(), rest.dnsCache().catch(() => [] as RosRecord[])]);
  const moved = deltas(conns, st.prev);
  const names = namesByAddress(dns);
  const byMac = new Map<string, Flow[]>();
  for (const d of payload.model.devices) {
    if (!d.mac || !d.ip) continue;
    const flows = flowsFor(d.ip, moved, names, payload.model).filter((f) => f.down + f.up > 0);
    if (flows.length) byMac.set(d.mac, flows);
  }
  store.addTalks(now, byMac);
  st.lastTick = now;
  if (now - st.lastPrune > 6 * 3600_000) {
    store.prune(now);
    st.lastPrune = now;
  }
}

/** Per device: online, traffic now (down, up) and Wi-Fi signal. */
export function samplesOf(p: NetworkPayload): Record<string, [0 | 1, number | null, number | null, number | null]> {
  const out: Record<string, [0 | 1, number | null, number | null, number | null]> = {};
  const { model: m } = p;
  for (const d of m.devices) {
    if (!d.mac) continue;
    const port = d.via?.kind === "port" && d.parent === m.routerId ? m.ports.find((x) => x.name === d.via?.port) : undefined;
    const down = d.via?.kind === "wifi" ? d.via.downBps : port?.txBps;
    const up = d.via?.kind === "wifi" ? d.via.upBps : port?.rxBps;
    out[d.mac] = [d.status === "online" ? 1 : 0, down ?? null, up ?? null, d.via?.signal ?? null];
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
