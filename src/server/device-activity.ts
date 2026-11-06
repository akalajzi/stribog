// The details behind "Details" on a device: who it talks to now, and what Stribog recorded.

import { resolve } from "node:path";
import { flowsFor, namesByAddress, type Flow } from "../core/activity.ts";
import { normMac } from "../core/net.ts";
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
}

const DEMO_HISTORY = resolve(import.meta.dirname, "../../fixtures/demo/history");

export async function deviceActivity(o: { session?: Session; agent: boolean; id: string; hours: number }): Promise<DeviceActivity | undefined> {
  const cfg = resolveConfigPath();
  const demo = o.session?.kind === "demo" || (!o.session && !o.agent && (!cfg || resolve(cfg) === DEMO_CONFIG));
  const payload = o.agent ? await getNetworkForAgent() : await getNetwork(o.session);
  if (!payload) return undefined;
  const m = payload.model;
  const d = m.devices.find((x) => x.id === o.id) ?? m.devices.find((x) => x.mac && x.mac === normMac(o.id));
  if (!d) return undefined;

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
  const flows = d.ip ? flowsFor(d.ip, conns, namesByAddress(dns), m) : [];
  // An empty cache usually means devices ask another DNS server, so the router has no names to give.
  const lan = m.networks.find((n) => n.role === "lan");
  const dnsServer = lan?.dhcp?.dns.find((ip) => ip !== lan.gateway);
  const dnsName = dnsServer ? (m.devices.find((x) => x.ip === dnsServer)?.name ?? dnsServer) : undefined;
  const noNames = conns.length && !dns.length ? `The router's DNS cache is empty${dnsName ? `: devices here ask ${dnsName} for names, not the router` : ""}, so the other ends show as addresses.` : undefined;

  // History: what the recorder kept. The demo ships a day of it, ending when its data was taken.
  const store = demo ? new HistoryStore(DEMO_HISTORY) : historyFor(setup().dataDir);
  const to = demo ? Date.parse(m.generatedAt.replace(" ", "T")) : Date.now();
  const from = to - o.hours * 3600_000;
  return {
    device: { id: d.id, name: d.name, ip: d.ip, mac: d.mac },
    now: { at: payload.meta.refreshedAt, flows, note, noNames },
    history: {
      from,
      to,
      samples: d.mac ? store.samples(d.mac, from, to) : [],
      talks: d.mac ? store.talks(d.mac, from, to) : [],
      since: store.since(),
      recording: !demo && recorderActive(),
    },
  };
}
