// Deterministic, tidy topology layout.
//
// Top to bottom: Internet → ISP router (with the old upstream network beside it) → gateway →
// devices on gateway ports, in port order so links never cross → devices behind those.
// Devices behind an access point sit in rows below it: wired first, then Wi-Fi by signal.

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


export interface LZone {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
}

/** The shared trunk and row branches under a device with several devices behind it. */
export interface LBus {
  id: string;
  from: string;
  d: string;
  /** Every device on it is on Wi-Fi. */
  wifi: boolean;
}

export interface Layout {
  nodes: LNode[];
  links: LLink[];
  buses: LBus[];
  zones: LZone[];
  bounds: { x: number; y: number; w: number; h: number };
  portX: Record<string, number>;
}

export const GATEWAY_W = 236;
export const GATEWAY_H = 62;
const ROW = { internet: 0, upstream: 170, gateway: 380, tier1: 640 };
const NODE_W = 190;
const UPSTREAM_COL_W = 178;
/** The node that stands for every device seen only on the ISP router's network. */
export const UPSTREAM_GROUP = "upstream:others";
/** Devices behind one device: columns per row, cell width and row height. */
const KID_COLS = 4;
const KID_W = 168;
const KID_ROW_H = 178;

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
  const buses: LBus[] = [];
  const zones: LZone[] = [];
  const byId = new Map(m.devices.map((d) => [d.id, d]));
  const router = m.routerId ? byId.get(m.routerId) : undefined;
  const upstream = byId.get("upstream");
  const children = (id: string) => m.devices.filter((d) => d.parent === id);

  // Devices on the ISP router's network: the router only glimpses them (ARP), so they are one
  // group beside the ISP router. Only those plugged into one of this router's ports are drawn.
  const upstreamSide = m.devices.filter((d) => d.zone === "upstream" && d.id !== "upstream" && d.mac);
  const onRouterPort = upstreamSide.filter((d) => router && d.parent === router.id && d.via?.port);
  const elsewhere = upstreamSide.filter((d) => !onRouterPort.includes(d));

  // Gateway and its port x positions (ports sit on the front panel of the drawing).
  const gx = 0;
  const gy = ROW.gateway;
  const t1 = ROW.tier1;
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

  // What hangs off a device: wired first (port order), then Wi-Fi, strongest signal first.
  const kidsOf = (id: string) => {
    const kids = children(id);
    const wired = kids.filter((c) => c.via?.kind !== "wifi");
    const wifi = kids.filter((c) => c.via?.kind === "wifi").sort((a, b) => (b.via?.signal ?? -99) - (a.via?.signal ?? -99));
    return [...wired, ...wifi];
  };
  const even = (n: number) => n + (n % 2);
  const widthOf = (s: Slot) => (s.kind === "device" ? Math.max(NODE_W, Math.min(even(kidsOf(s.dev.id).length), KID_COLS) * KID_W + 24) : NODE_W);
  const widths = tier1.map(widthOf);
  const total = widths.reduce((a, b) => a + b, 0);
  let cursor = gx - total / 2;

  tier1.forEach((s, i) => {
    const w = widths[i]!;
    const x = cursor + w / 2;
    cursor += w;
    const id = s.kind === "device" ? s.dev.id : s.id;
    const isAp = s.kind === "device" ? s.dev.kind === "ap" : s.deviceKind === "ap";
    const kids = s.kind === "device" ? kidsOf(s.dev.id) : [];
    const y = t1;
    nodes.push({ id, x, y, kind: s.kind === "device" ? s.dev.kind : s.deviceKind, label: "below", ghost: s.kind === "ghost" });

    const port = ports.find((p) => p.name === s.port);
    const px = s.port && portX[s.port] !== undefined ? portX[s.port]! : gx;
    const y1 = gy + GATEWAY_H / 2 + 4;
    const y2 = y - (isAp ? 34 : 40);
    const medium = s.kind === "ghost" ? "planned" : mediumOf(s.dev, port);
    const wifiFromRouter = s.kind === "device" && s.dev.via?.kind === "wifi";
    links.push({
      id: `l:${id}`,
      from: router!.id,
      to: id,
      d: vcurve(px, y1, x, y2),
      medium,
      label: wifiFromRouter ? undefined : [s.port, speedLabel(port?.speedMbps), port?.poeWatts ? `PoE ${port.poeWatts} W` : ""].filter(Boolean).join(" · "),
      labelAt: { x: x + 8, y: y2 - 14, anchor: "start" },
      weight: s.kind === "ghost" ? 0 : medium === "2.5g" ? 0.9 : 0.5,
    });

    // Devices behind this one, in rows under a trunk that starts below the device's label and
    // branches above each row. Rows have an even number of places, so the trunk runs through a
    // gap, never through a device. Each device's own link is the drop from its branch.
    if (!kids.length) return;
    const trunkTop = y + 96;
    const rowY = (r: number) => y + 236 + r * KID_ROW_H;
    const branchY = (r: number) => rowY(r) - 70;
    const rows = Math.ceil(kids.length / KID_COLS);
    const bus: string[] = [`M ${round(x)} ${round(trunkTop)} V ${round(branchY(rows - 1))}`];
    for (let r = 0; r < rows; r++) {
      const inRow = kids.slice(r * KID_COLS, (r + 1) * KID_COLS);
      const places = even(inRow.length);
      const xs = inRow.map((_, j) => x + (j - (places - 1) / 2) * KID_W);
      bus.push(`M ${round(Math.min(x, ...xs))} ${round(branchY(r))} H ${round(Math.max(x, ...xs))}`);
      inRow.forEach((c, j) => {
        const cx = xs[j]!;
        const cy = rowY(r);
        nodes.push({ id: c.id, x: cx, y: cy, kind: c.kind, label: "below" });
        const wifi = c.via?.kind === "wifi";
        links.push({
          id: `l:${c.id}`,
          from: id,
          to: c.id,
          d: `M ${round(cx)} ${round(branchY(r))} V ${round(cy - 40)}`,
          medium: mediumOf(c),
          label: wifi ? undefined : (c.via?.port ?? ""),
          labelAt: { x: cx + 7, y: branchY(r) + 20, anchor: "start" },
          weight: 0.5,
        });
      });
    }
    buses.push({ id: `bus:${id}`, from: id, d: bus.join(" "), wifi: kids.every((c) => c.via?.kind === "wifi") });
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
  if (upstream || upstreamSide.length) {
    const y = ROW.upstream + 10;
    const items: { id: string; kind: string; dev?: Device }[] = [
      ...(elsewhere.length ? [{ id: UPSTREAM_GROUP, kind: "group" }] : []),
      ...onRouterPort.map((d) => ({ id: d.id, kind: d.kind, dev: d })),
    ];
    items.forEach((it, k) => {
      const x = gx - 250 - k * UPSTREAM_COL_W;
      nodes.push({ id: it.id, x, y, kind: it.kind, label: "below" });
      if (it.dev && router) {
        const px = portX[it.dev.via!.port!] ?? gx;
        links.push({ id: `l:${it.id}`, from: router.id, to: it.id, d: `M ${px} ${gy - GATEWAY_H / 2 - 4} C ${px} ${gy - 120}, ${x} ${y + 150}, ${x} ${y + 76}`, medium: "legacy", label: it.dev.via!.port, labelAt: { x: (px + x) / 2 - 6, y: gy - 92, anchor: "end" }, weight: 0.2 });
      }
    });
    const minX = items.length ? gx - 250 - (items.length - 1) * UPSTREAM_COL_W - UPSTREAM_COL_W / 2 - 10 : gx - 140;
    const sub = [m.wan.gateway ? m.wan.gateway.replace(/\.\d+$/, ".0/24") : "", upstream?.name ?? "ISP router"].filter(Boolean).join(" · ");
    zones.push({ x: minX, y: ROW.upstream - 92, w: gx + 210 - minX, h: 240, title: "Upstream", sub });
  }

  // ---- bounds -----------------------------------------------------------------------
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const pad = 60;
  const x0 = Math.min(...xs, ...zones.map((z) => z.x)) - pad;
  const x1 = Math.max(...xs, ...zones.map((z) => z.x + z.w)) + pad + 120;
  const y0 = Math.min(...ys) - 90;
  const y1 = Math.max(...ys) + 120;
  return { nodes, links, buses, zones, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, portX };
}

function vcurve(x1: number, y1: number, x2: number, y2: number): string {
  const my = (y1 + y2) / 2;
  return `M ${round(x1)} ${round(y1)} C ${round(x1)} ${round(my)}, ${round(x2)} ${round(my)}, ${round(x2)} ${round(y2)}`;
}

const round = (n: number) => Math.round(n * 10) / 10;

export type { Band };
