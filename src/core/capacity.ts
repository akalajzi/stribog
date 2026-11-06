// How full each link is: traffic now against what the link can carry.
//
// A cable carries its negotiated speed each way. A Wi-Fi link's rate is the radio's signalling
// rate, of which a device gets roughly 60% as real throughput (protocol overhead, airtime shared
// with others); that share is a rule of thumb, so loads on Wi-Fi are marked as estimates.

import { connectionViews, type Device, type NetworkModel, type Port } from "./model.ts";
import { fmtBps } from "./net.ts";

/** Throughput a Wi-Fi device can expect from its link rate. A rule of thumb. */
export const WIFI_USABLE = 0.6;
/** At or above this share of what a link can carry, it is at its limit. */
export const FULL = 0.8;

export interface Capacity {
  /** Bits per second each way: towards the device (down) and from it (up). */
  down?: number;
  up?: number;
  /** "1 Gb/s cable", "Wi-Fi, about 520 Mb/s of its 866 Mb/s link rate". */
  label: string;
  /** An estimate (Wi-Fi), not a hard limit. */
  estimate?: boolean;
}

/** "866.7Mbps", "1.2Gbps", "866.7Mbps-80MHz/2S" → bits per second. */
export function rateBps(r?: string): number | undefined {
  const m = /([\d.]+)\s*([kMG])bps/i.exec(r ?? "");
  if (!m) return undefined;
  return Number(m[1]) * { k: 1e3, m: 1e6, g: 1e9 }[m[2]!.toLowerCase() as "k" | "m" | "g"];
}

export function portCapacity(p?: Port): Capacity | undefined {
  if (!p?.speedMbps) return undefined;
  const bps = p.speedMbps * 1e6;
  return { down: bps, up: bps, label: `${fmtBps(bps)} cable` };
}

export function wifiCapacity(d: Pick<Device, "via">): Capacity | undefined {
  const tx = rateBps(d.via?.txRate);
  const rx = rateBps(d.via?.rxRate);
  if (!tx && !rx) return undefined;
  const best = Math.max(tx ?? 0, rx ?? 0);
  return {
    down: tx && tx * WIFI_USABLE,
    up: rx && rx * WIFI_USABLE,
    label: `Wi-Fi, about ${fmtBps(best * WIFI_USABLE)} of its ${fmtBps(best)} link rate`,
    estimate: true,
  };
}

/** The fuller direction's share of what the link carries, 0..1+; undefined without both numbers. */
export function loadOf(down: number | undefined, up: number | undefined, c: Capacity | undefined): number | undefined {
  if (!c) return undefined;
  const shares = [c.down && down !== undefined ? down / c.down : undefined, c.up && up !== undefined ? up / c.up : undefined].filter((x): x is number => x !== undefined);
  return shares.length ? Math.max(...shares) : undefined;
}

/** A link at or near its limit right now. */
export interface FullLink {
  /** Stable across reads: "port:ether3", "wifi:<MAC>". */
  id: string;
  /** "ether3 (wap-soba)", "R2M2 on Wi-Fi". */
  label: string;
  deviceIds: string[];
  share: number;
  downBps: number;
  upBps: number;
  capacity: string;
  estimate?: boolean;
}

/** Every link whose traffic now is at FULL or above: the router's ports, and each Wi-Fi device's link. */
export function fullLinks(m: NetworkModel, at = FULL): FullLink[] {
  const out: FullLink[] = [];
  const name = (id: string) => m.devices.find((d) => d.id === id)?.name ?? id;
  for (const p of m.ports) {
    // A port's tx goes towards what is plugged in, rx comes from it.
    const c = portCapacity(p);
    const share = loadOf(p.txBps, p.rxBps, c);
    if (share === undefined || share < at) continue;
    const who = p.deviceIds.map(name);
    out.push({ id: `port:${p.name}`, label: `${p.name}${who.length ? ` (${who.slice(0, 2).join(", ")}${who.length > 2 ? "…" : ""})` : ""}`, deviceIds: p.deviceIds, share, downBps: p.txBps ?? 0, upBps: p.rxBps ?? 0, capacity: c!.label });
  }
  // Each connection of a machine on its own: its Wi-Fi can be full while its cable is idle.
  for (const d of connectionViews(m.devices)) {
    if (d.via?.kind !== "wifi" || d.via.measured || !d.mac) continue;
    const c = wifiCapacity(d);
    const share = loadOf(d.via.downBps, d.via.upBps, c);
    if (share === undefined || share < at) continue;
    out.push({ id: `wifi:${d.mac}`, label: `${d.name} on Wi-Fi`, deviceIds: [d.id], share, downBps: d.via.downBps ?? 0, upBps: d.via.upBps ?? 0, capacity: c!.label, estimate: true });
  }
  return out.sort((a, b) => b.share - a.share);
}
