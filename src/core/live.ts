// Traffic between full reads: the few numbers that change by the second (port throughput, each
// Wi-Fi device's rates and signal, the router's load), read on their own and laid over the last
// full picture. Pure; the server reads them, the browser applies them.

import { bps, connectionsOf, wifiRate, type NetworkModel } from "./model.ts";
import { normMac, parseSignal } from "./net.ts";
import type { RosRecord } from "./ros.ts";

export interface LiveRates {
  /** When they were read, ms. */
  at: number;
  /** Per router port: [rx, tx] bits per second. */
  ports: Record<string, [number | null, number | null]>;
  /** Per Wi-Fi MAC: [down, up] bits per second, signal dBm, tx rate, rx rate. */
  wifi: Record<string, [number | null, number | null, number | null, string | null, string | null]>;
  cpuLoad?: number;
}

/** From the router's monitor-traffic rows, registration table and resource. */
export function liveRatesFrom(traffic: RosRecord[], reg: RosRecord[], resource?: RosRecord, at = Date.now()): LiveRates {
  const ports: LiveRates["ports"] = {};
  for (const t of traffic) if (t.name) ports[t.name] = [bps(t["rx-bits-per-second"]) ?? null, bps(t["tx-bits-per-second"]) ?? null];
  const wifi: LiveRates["wifi"] = {};
  for (const r of reg) {
    const mac = r["mac-address"] ? normMac(r["mac-address"]) : undefined;
    // The access point transmits towards the client.
    if (mac) wifi[mac] = [bps(r["tx-bits-per-second"]) ?? null, bps(r["rx-bits-per-second"]) ?? null, parseSignal(r.signal ?? r["signal-strength"]) ?? null, wifiRate(r["tx-rate"]) ?? null, wifiRate(r["rx-rate"]) ?? null];
  }
  const cpu = Number(resource?.["cpu-load"]);
  return { at, ports, wifi, ...(Number.isFinite(cpu) && resource?.["cpu-load"] !== undefined ? { cpuLoad: cpu } : {}) };
}

/**
 * The model with fresher traffic. Only what the rates cover changes: a device that left keeps its
 * last picture until the next full read, and traffic measured from connections stays as it was.
 */
export function applyRates(m: NetworkModel, r: LiveRates): NetworkModel {
  const ports = m.ports.map((p) => {
    const x = r.ports[p.name];
    return x ? { ...p, rxBps: x[0] ?? p.rxBps, txBps: x[1] ?? p.txBps } : p;
  });
  const fresh = <T extends { mac?: string; via?: NetworkModel["devices"][number]["via"] }>(l: T): T => {
    const x = l.mac && l.via?.kind === "wifi" && !l.via.measured ? r.wifi[l.mac] : undefined;
    if (!x) return l;
    return { ...l, via: { ...l.via!, downBps: x[0] ?? undefined, upBps: x[1] ?? undefined, signal: x[2] ?? l.via!.signal, txRate: x[3] ?? l.via!.txRate, rxRate: x[4] ?? l.via!.rxRate } };
  };
  const devices = m.devices.map((d) => {
    const next = fresh(d);
    return d.links ? { ...next, links: connectionsOf(d).map(fresh) } : next;
  });
  return { ...m, ports, devices, system: m.system && r.cpuLoad !== undefined ? { ...m.system, cpuLoad: r.cpuLoad } : m.system };
}
