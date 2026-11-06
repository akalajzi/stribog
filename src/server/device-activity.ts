// The details behind "Details" on a device: who it talks to now, and what Stribog recorded.

import { resolve } from "node:path";
import { byOwner, flowsFor, namesByAddress, type Flow, type OwnerShare } from "../core/activity.ts";
import { AsnDb, asnDb, reverseName } from "./owners.ts";
import { normMac } from "../core/net.ts";
import { connectionsOf } from "../core/model.ts";
import { RouterOsRest } from "../core/rest.ts";
import type { RosRecord } from "../core/ros.ts";
import { HistoryStore, type Sample, type Talk } from "./history.ts";
import { DEMO_CONFIG, demoState, filesState, getNetwork, getNetworkForAgent, liveSession, resolveConfigPath, setup } from "./provider.ts";
import { historyFor, recorderActive } from "./recorder.ts";
import type { Session } from "./session.ts";

export interface DeviceActivity {
  device: { id: string; name: string; ip?: string; mac?: string };
  now: { at: string; flows: Flow[]; note?: string; noNames?: string };
  history: { from: number; to: number; samples: Sample[]; talks: Talk[]; since?: string; recording: boolean };
  /** Top talkers by network owner, now and over the period. `ready` is false while the owner database is still coming. */
  owners: { now: OwnerShare[]; recorded: OwnerShare[]; ready: boolean };
}

const DEMO_HISTORY = resolve(import.meta.dirname, "../../fixtures/demo/history");
const DEMO_ASN = resolve(import.meta.dirname, "../../fixtures/demo/asn.tsv");
let demoAsn: Promise<AsnDb> | undefined;

export async function deviceActivity(o: { session?: Session; agent: boolean; id: string; hours: number }): Promise<DeviceActivity | undefined> {
  const cfg = resolveConfigPath();
  const demo = o.session?.kind === "demo" || (!o.session && !o.agent && (!cfg || resolve(cfg) === DEMO_CONFIG));
  const payload = o.agent ? await getNetworkForAgent() : await getNetwork(o.session);
  if (!payload) return undefined;
  const m = payload.model;
  // A machine's other connections are found by their MAC too (an old link, a bookmark).
  const d = m.devices.find((x) => x.id === o.id) ?? m.devices.find((x) => connectionsOf(x).some((l) => l.mac === normMac(o.id.replace(/^mac:/, ""))));
  if (!d) return undefined;
  const links = connectionsOf(d);
  const macs = links.map((l) => l.mac);

  // Now: the router's connection table and DNS cache, read fresh.
  let conns: RosRecord[] = [];
  let dns: RosRecord[] = [];
  let note: string | undefined;
  if (demo) {
    const st = demoState();
    conns = st?.["/ip/firewall/connection"] ?? [];
    dns = st?.["/ip/dns/cache"] ?? [];
  } else {
    const r = o.session?.router ?? liveSession()?.router;
    if (r) {
      const rest = new RouterOsRest({ url: r.url, user: r.user, password: r.password, insecure: r.encrypted });
      [conns, dns] = await Promise.all([rest.connections(), rest.dnsCache().catch(() => [] as RosRecord[])]);
    } else if (filesState()?.["/ip/firewall/connection"]) {
      conns = filesState()!["/ip/firewall/connection"]!;
      dns = filesState()!["/ip/dns/cache"] ?? [];
      note = "From the saved snapshot, not live.";
    } else note = "Sign in to the router to see who it is talking to right now.";
  }
  const names = namesByAddress(dns);
  const flows = mergeFlows(links.flatMap((l) => (l.ip ? flowsFor(l.ip, conns, names, m) : [])));
  // An empty cache usually means devices ask another DNS server, so the router has no names to give.
  const lan = m.networks.find((n) => n.role === "lan");
  const dnsServer = lan?.dhcp?.dns.find((ip) => ip !== lan.gateway);
  const dnsName = dnsServer ? (m.devices.find((x) => connectionsOf(x).some((l) => l.ip === dnsServer))?.name ?? dnsServer) : undefined;
  const noNames = conns.length && !dns.length ? `The router's DNS cache is empty${dnsName ? `: devices here ask ${dnsName} for names, not the router` : ""}, so the other ends show as addresses.` : undefined;

  // History: what the recorder kept. The demo ships a day of it, ending when its data was taken.
  const store = demo ? new HistoryStore(DEMO_HISTORY) : historyFor(setup().dataDir);
  const to = demo ? Date.parse(m.generatedAt.replace(" ", "T")) : Date.now();
  const from = to - o.hours * 3600_000;
  const talks = macs.length ? store.talks(macs, from, to) : [];

  // Who runs the other ends: the offline ASN database, and reverse DNS for the busiest few.
  const db = demo ? await (demoAsn ??= AsnDb.load(DEMO_ASN)) : asnDb(setup().dataDir);
  const internet = [...flows, ...talks].filter((f) => f.scope === "internet");
  for (const f of internet) {
    const own = db?.lookup(f.remote);
    if (own) f.owner = { asn: own.asn, name: own.name, country: own.country };
  }
  if (!demo) {
    const busiest = [...new Set(internet.sort((a, b) => b.down + b.up - (a.down + a.up)).map((f) => f.remote))].slice(0, 20);
    const names = new Map(await Promise.all(busiest.map(async (ip) => [ip, await reverseName(ip)] as const)));
    for (const f of internet) f.ptr = names.get(f.remote) ?? undefined;
  }
  return {
    device: { id: d.id, name: d.name, ip: d.ip, mac: d.mac },
    now: { at: payload.meta.refreshedAt, flows, note, noNames },
    history: {
      from,
      to,
      samples: macs.length ? store.samples(macs, from, to) : [],
      talks,
      since: store.since(),
      recording: !demo && recorderActive(),
    },
    owners: { now: byOwner(flows).slice(0, 10), recorded: byOwner(talks).slice(0, 10), ready: !!db },
  };
}

/** Flows of several connections as one list: the same other end and port add up. */
function mergeFlows(flows: Flow[]): Flow[] {
  const out = new Map<string, Flow>();
  for (const f of flows) {
    const key = `${f.direction}|${f.protocol}|${f.remote}|${f.port ?? ""}`;
    const p = out.get(key);
    if (!p) out.set(key, { ...f });
    else {
      p.down += f.down;
      p.up += f.up;
      p.connections += f.connections;
      p.fasttracked ||= f.fasttracked;
    }
  }
  return [...out.values()].sort((a, b) => b.down + b.up - (a.down + a.up) || b.connections - a.connections);
}
