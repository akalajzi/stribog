// Deterministic, tidy topology layout.
//
// Top to bottom: Internet → ISP router (with the old upstream network beside it) → gateway →
// devices on gateway ports, in port order so links never cross → devices behind those.
// Wi-Fi clients orbit their access point at a distance that grows as the signal weakens.

import type { Device, NetworkModel, Port } from "./model.ts";
import type { Band } from "./net.ts";

export type Medium = "2.5g" | "1g" | "100m" | "wired" | "wan" | "legacy" | "wifi-2.4" | "wifi-5" | "wifi-6" | "planned";

export interface LNode {
  id: string;
  x: number;
  y: number;
  kind: string;
  label: "below" | "left" | "right" | "pill";
  ghost?: boolean;
  client?: boolean;
  /** For orbit clients: label side. */
  side?: "left" | "right";
}

export interface LLink {
  id: string;
  from: string;
  to: string;
  d: string;
  medium: Medium;
  label?: string;
  labelAt?: { x: number; y: number; anchor: "start" | "middle" | "end" };
  /** Rough traffic weight 0..1 for particle animation. */
  weight: number;
  reverse?: boolean;
}

export interface LOrbit {
  apId: string;
  x: number;
  y: number;
  rings: { r: number; dbm: number }[];
}

export interface LZone {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
}

export interface Layout {
  nodes: LNode[];
  links: LLink[];
  orbits: LOrbit[];
  zones: LZone[];
  bounds: { x: number; y: number; w: number; h: number };
  portX: Record<string, number>;
}

export const GATEWAY_W = 236;
export const GATEWAY_H = 62;
const ROW = { internet: 0, upstream: 170, gateway: 380, tier1: 640 };
const NODE_W = 190;
const ORBIT_MIN = 72;
const ORBIT_MAX = 176;

export const orbitRadius = (signal?: number) => {
  if (signal === undefined) return ORBIT_MAX - 20;
  const r = ORBIT_MIN + (Math.abs(signal) - 50) * 4.6;
  return Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, r));
};

export function mediumOf(d: Device, port?: Port, ghost?: boolean): Medium {
  if (ghost) return "planned";
  if (d.via?.kind === "wifi") return d.via.band === "2.4" ? "wifi-2.4" : d.via.band === "6" ? "wifi-6" : "wifi-5";
  if (d.zone === "upstream") return "legacy";
  const s = port?.speedMbps;
  if (s === undefined) return "wired";
  return s >= 2500 ? "2.5g" : s >= 1000 ? "1g" : "100m";
}

const speedLabel = (mbps?: number) => (mbps === undefined ? "" : mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);

export function layoutTopology(m: NetworkModel): Layout {
  const nodes: LNode[] = [];
  const links: LLink[] = [];
  const orbits: LOrbit[] = [];
  const zones: LZone[] = [];
  const byId = new Map(m.devices.map((d) => [d.id, d]));
  const router = m.routerId ? byId.get(m.routerId) : undefined;
  const upstream = byId.get("upstream");
  const children = (id: string) => m.devices.filter((d) => d.parent === id);

  // Gateway and its port x positions (ports sit on the front panel of the drawing).
  const gx = 0;
  const gy = ROW.gateway;
  const portX: Record<string, number> = {};
  const ports = m.ports;
  const left = gx - GATEWAY_W / 2;
  const eth = ports.filter((p) => p.kind === "ethernet");
  const sfp = ports.filter((p) => p.kind === "sfp");
  // Must match GatewayArt: ethernet ports from x=70, SFP cages at the right edge.
  const step = eth.length > 1 ? Math.min(15.5, 118 / (eth.length - 1)) : 0;
  eth.forEach((p, i) => (portX[p.name] = left + 70 + i * step));
  sfp.forEach((p, i) => (portX[p.name] = left + GATEWAY_W - 26 - i * 22));

  // ---- tier 1: what hangs off gateway LAN ports, in port order -------------------
  type Slot = { kind: "device"; dev: Device; port?: string } | { kind: "ghost"; id: string; name: string; deviceKind: string; port?: string };
  const tier1: Slot[] = [];
  if (router) {
    for (const d of children(router.id)) if (d.zone !== "upstream") tier1.push({ kind: "device", dev: d, port: d.via?.port });
    for (const p of m.planned) tier1.push({ kind: "ghost", id: `planned:${p.id}`, name: p.name, deviceKind: p.kind, port: p.port });
  }
  const portIndex = (p?: string) => (p ? ports.findIndex((x) => x.name === p) : 999);
  tier1.sort((a, b) => portIndex(a.port) - portIndex(b.port));

  const widthOf = (s: Slot) => {
    if (s.kind === "device" && s.dev.kind === "ap") {
      const wifi = children(s.dev.id).filter((c) => c.via?.kind === "wifi");
      return wifi.length ? 2 * ORBIT_MAX + 120 : NODE_W;
    }
    return NODE_W;
  };
  const widths = tier1.map(widthOf);
  const total = widths.reduce((a, b) => a + b, 0);
  let cursor = gx - total / 2;

  tier1.forEach((s, i) => {
    const w = widths[i]!;
    const x = cursor + w / 2;
    cursor += w;
    const id = s.kind === "device" ? s.dev.id : s.id;
    const isAp = s.kind === "device" ? s.dev.kind === "ap" : s.deviceKind === "ap";
    const wifiKids = s.kind === "device" ? children(s.dev.id).filter((c) => c.via?.kind === "wifi") : [];
    const y = ROW.tier1 + (wifiKids.length ? 60 : 0);
    nodes.push({ id, x, y, kind: s.kind === "device" ? s.dev.kind : s.deviceKind, label: isAp && wifiKids.length ? "pill" : "below", ghost: s.kind === "ghost" });

    const port = ports.find((p) => p.name === s.port);
    const px = s.port && portX[s.port] !== undefined ? portX[s.port]! : gx;
    const y1 = gy + GATEWAY_H / 2 + 4;
    const y2 = y - (isAp ? 34 : 40);
    const medium = s.kind === "ghost" ? "planned" : mediumOf(s.dev, port);
    links.push({
      id: `l:${id}`,
      from: router!.id,
      to: id,
      d: vcurve(px, y1, x, y2),
      medium,
      label: [s.port, speedLabel(port?.speedMbps), port?.poeWatts ? `PoE ${port.poeWatts} W` : ""].filter(Boolean).join(" · "),
      labelAt: { x: (px + x) / 2 + (x >= px ? 8 : -8), y: (y1 + y2) / 2 + 4, anchor: x >= px ? "start" : "end" },
      weight: s.kind === "ghost" ? 0 : medium === "2.5g" ? 0.9 : 0.5,
    });

    if (s.kind !== "device") return;

    // Wi-Fi orbit
    if (wifiKids.length) {
      orbits.push({ apId: id, x, y, rings: [-55, -65, -75].map((dbm) => ({ dbm, r: orbitRadius(dbm) })) });
      const sorted = [...wifiKids].sort((a, b) => (b.via?.signal ?? -99) - (a.via?.signal ?? -99));
      const right = sorted.filter((_, k) => k % 2 === 0);
      const leftSide = sorted.filter((_, k) => k % 2 === 1);
      const place = (list: Device[], side: "left" | "right") => {
        // Avoid straight up (uplink) and straight down (wired children): use ±(25°..155°) arcs.
        list.forEach((c, k) => {
          const t = list.length === 1 ? 0.5 : k / (list.length - 1);
          const deg = -62 + t * 124; // -62..62 around the horizontal
          const rad = ((side === "right" ? deg : 180 - deg) * Math.PI) / 180;
          const r = orbitRadius(c.via?.signal);
          nodes.push({ id: c.id, x: x + r * Math.cos(rad), y: y + r * Math.sin(rad), kind: c.kind, label: side, client: true, side });
        });
      };
      place(right, "right");
      place(leftSide, "left");
    }

    // Wired devices behind this one
    const wired = children(id).filter((c) => c.via?.kind !== "wifi");
    const ty = y + (wifiKids.length ? ORBIT_MAX + 70 : 210);
    wired.forEach((c, k) => {
      const cx = x + (k - (wired.length - 1) / 2) * NODE_W;
      nodes.push({ id: c.id, x: cx, y: ty, kind: c.kind, label: wifiKids.length ? "right" : "below" });
      const from = wifiKids.length ? y + 46 : y + 76;
      links.push({ id: `l:${c.id}`, from: id, to: c.id, d: vcurve(x, from, cx, ty - 22), medium: mediumOf(c), label: c.via?.port ?? "", labelAt: { x: x - 8, y: (from + ty) / 2 + 30, anchor: "end" }, weight: 0.5 });
    });
  });

  // ---- spine: internet, upstream, gateway ----------------------------------------
  const ix = gx;
  nodes.push({ id: "internet", x: ix, y: ROW.internet, kind: "internet", label: "right" });
  if (upstream) {
    nodes.push({ id: "upstream", x: gx, y: ROW.upstream, kind: "isp", label: "right" });
    links.push({ id: "l:upstream", from: "internet", to: "upstream", d: vcurve(ix, ROW.internet + 30, gx, ROW.upstream - 36), medium: "wan", weight: 0.7 });
  }
  if (router) {
    nodes.push({ id: router.id, x: gx, y: gy, kind: "router", label: "left" });
    const wanPort = router.via?.port;
    const wx = wanPort && portX[wanPort] !== undefined ? portX[wanPort]! : gx;
    const fromY = upstream ? ROW.upstream + 40 : ROW.internet + 30;
    links.push({
      id: `l:${router.id}`,
      from: upstream ? "upstream" : "internet",
      to: router.id,
      d: vcurve(gx, fromY, wx, gy - GATEWAY_H / 2 - 4),
      medium: "wan",
      label: [wanPort, speedLabel(ports.find((p) => p.name === wanPort)?.speedMbps), m.wan.doubleNat === true ? "double NAT" : ""].filter(Boolean).join(" · "),
      labelAt: { x: Math.max(gx, wx) + 14, y: (fromY + gy - 34) / 2 + 6, anchor: "start" },
      weight: 0.8,
    });
  }

  // ---- upstream zone: the ISP router's own network ------------------------------
  const legacy = m.devices.filter((d) => d.zone === "upstream" && d.id !== "upstream" && d.mac);
  if (upstream || legacy.length) {
    const colW = 168;
    legacy.forEach((d, k) => {
      const x = gx - 250 - k * colW;
      const y = ROW.upstream + 10;
      nodes.push({ id: d.id, x, y, kind: d.kind, label: "below" });
      const viaRouterPort = d.parent === router?.id && d.via?.port;
      if (viaRouterPort) {
        const px = portX[d.via!.port!] ?? gx;
        links.push({ id: `l:${d.id}`, from: router!.id, to: d.id, d: `M ${px} ${gy - GATEWAY_H / 2 - 4} C ${px} ${gy - 120}, ${x} ${y + 150}, ${x} ${y + 76}`, medium: "legacy", label: d.via!.port, labelAt: { x: (px + x) / 2 - 6, y: gy - 92, anchor: "end" }, weight: 0.2 });
      } else {
        links.push({ id: `l:${d.id}`, from: "upstream", to: d.id, d: `M ${gx - 40} ${ROW.upstream} C ${gx - 120} ${ROW.upstream}, ${x + 90} ${y - 50}, ${x + 30} ${y - 26}`, medium: d.kind === "printer" || d.kind === "phone" || d.kind === "laptop" ? "wifi-2.4" : "legacy", weight: 0.15 });
      }
    });
    const minX = legacy.length ? gx - 250 - (legacy.length - 1) * colW - colW / 2 - 10 : gx - 140;
    zones.push({ x: minX, y: ROW.upstream - 92, w: gx + 210 - minX, h: 240, title: "Upstream", sub: m.wan.gateway ? `${m.wan.gateway.replace(/\.\d+$/, ".0/24")} · ${upstream?.name ?? "ISP router"}` : upstream?.name });
  }

  // ---- bounds -----------------------------------------------------------------------
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const pad = 60;
  const x0 = Math.min(...xs, ...zones.map((z) => z.x)) - pad;
  const x1 = Math.max(...xs, ...zones.map((z) => z.x + z.w)) + pad + 120;
  const y0 = Math.min(...ys) - 90;
  const y1 = Math.max(...ys) + 120;
  return { nodes, links, orbits, zones, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, portX };
}

function vcurve(x1: number, y1: number, x2: number, y2: number): string {
  const my = (y1 + y2) / 2;
  return `M ${round(x1)} ${round(y1)} C ${round(x1)} ${round(my)}, ${round(x2)} ${round(my)}, ${round(x2)} ${round(y2)}`;
}

const round = (n: number) => Math.round(n * 10) / 10;

export type { Band };
