// Deterministic, tidy topology layout.
//
// Top to bottom: Internet → ISP router (with the old upstream network beside it) → gateway →
// devices on gateway ports, in port order so links never cross → devices behind those.
// Devices behind an access point sit below it in one cluster per medium (cable, each Wi-Fi band),
// each with its own line in that medium's colour.

import { portCapacity, wifiCapacity, type Capacity } from "./capacity.ts";
import type { Device, NetworkModel, Port } from "./model.ts";
import type { Band } from "./net.ts";

export type Medium = "2.5g" | "1g" | "100m" | "wired" | "wan" | "legacy" | "wifi-2.4" | "wifi-5" | "wifi-6";

export interface LNode {
  id: string;
  x: number;
  y: number;
  kind: string;
  label: "below" | "left" | "right" | "pill";
}

export interface LLink {
  id: string;
  from: string;
  to: string;
  d: string;
  medium: Medium;
  label?: string;
  labelAt?: { x: number; y: number; anchor: "start" | "middle" | "end" };
  /** Current throughput along the link, bits per second: away from the router (down) and towards it (up). */
  down?: number;
  up?: number;
  /** The whole way traffic travels when it differs from what is drawn (a device in a cluster: AP → trunk → branch → drop). */
  route?: string;
  /** Rough length of the way traffic travels, px, so dots move at the same speed on long and short links. */
  len: number;
  reverse?: boolean;
  /** What the link can carry, when known: a cable's speed, or an estimate for Wi-Fi. */
  capacity?: Capacity;
}


export interface LZone {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
}

/** One cluster's line under a device: a curve down to the cluster's centre, then a branch over each row. */
export interface LBus {
  id: string;
  from: string;
  d: string;
  medium: Medium;
  label: string;
  labelAt: { x: number; y: number };
  /** The cluster's combined traffic, for its label. */
  down?: number;
  up?: number;
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
/** Devices behind one device: cell width, row height, gap between clusters. */
const KID_W = 188;
const KID_ROW_H = 178;
const CLUSTER_GAP = 44;

export function mediumOf(d: Device, port?: Port): Medium {
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
  type Slot = { dev: Device; port?: string };
  const tier1: Slot[] = [];
  if (router) {
    for (const d of children(router.id)) if (d.zone !== "upstream") tier1.push({ dev: d, port: d.via?.port });
  }
  const portIndex = (p?: string) => (p ? ports.findIndex((x) => x.name === p) : 999);
  tier1.sort((a, b) => portIndex(a.port) - portIndex(b.port));

  // What hangs off a device, one cluster per medium: cable, then each Wi-Fi band from 2.4 up.
  // Within a cluster, Wi-Fi goes from the strongest signal down.
  const clustersOf = (id: string): { medium: Medium; kids: Device[] }[] => {
    const kids = children(id);
    const groups = new Map<Medium, Device[]>();
    for (const c of kids) {
      const md = c.via?.kind === "wifi" ? mediumOf(c) : "wired";
      groups.set(md, [...(groups.get(md) ?? []), c]);
    }
    const order: Medium[] = ["wired", "wifi-2.4", "wifi-5", "wifi-6"];
    return [...groups.entries()]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([medium, ks]) => ({ medium, kids: medium === "wired" ? ks : [...ks].sort((a, b) => (b.via?.signal ?? -99) - (a.via?.signal ?? -99)) }));
  };
  // Up to three side by side; more go four to a row, so the centre line runs through the gap
  // between the middle two and only the last (possibly odd) row sits under its end.
  const colsFor = (n: number) => (n <= 3 ? n : 4);
  const clusterW = (n: number) => colsFor(n) * KID_W;
  const widthOf = (s: Slot) => {
    const cs = clustersOf(s.dev.id);
    return Math.max(NODE_W, cs.reduce((w, c) => w + clusterW(c.kids.length), 0) + Math.max(0, cs.length - 1) * CLUSTER_GAP + 24);
  };
  const widths = tier1.map(widthOf);
  const total = widths.reduce((a, b) => a + b, 0);
  let cursor = gx - total / 2;

  tier1.forEach((s, i) => {
    const w = widths[i]!;
    const x = cursor + w / 2;
    cursor += w;
    const id = s.dev.id;
    const isAp = s.dev.kind === "ap";
    const clusters = clustersOf(s.dev.id);
    const y = t1;
    nodes.push({ id, x, y, kind: s.dev.kind, label: "below" });

    const port = ports.find((p) => p.name === s.port);
    const px = s.port && portX[s.port] !== undefined ? portX[s.port]! : gx;
    const y1 = gy + GATEWAY_H / 2 + 4;
    const y2 = y - (isAp ? 34 : 40);
    const medium = mediumOf(s.dev, port);
    const wifiFromRouter = s.dev.via?.kind === "wifi";
    links.push({
      id: `l:${id}`,
      from: router!.id,
      to: id,
      d: vcurve(px, y1, x, y2),
      len: curveLen(px, y1, x, y2),
      medium,
      label: wifiFromRouter ? undefined : [s.port, speedLabel(port?.speedMbps), port?.poeWatts ? `PoE ${port.poeWatts} W` : ""].filter(Boolean).join(" · "),
      labelAt: { x: x + 8, y: y2 - 14, anchor: "start" },
      // A port shared through a switch counts everyone behind it; then each device's own measure.
      down: port && port.deviceIds.length <= 1 ? port.txBps : s.dev.via?.downBps,
      up: port && port.deviceIds.length <= 1 ? port.rxBps : s.dev.via?.upBps,
      // A port shared through a switch carries more than this device's traffic: no limit to compare with.
      capacity: wifiFromRouter ? wifiCapacity(s.dev) : port && port.deviceIds.length <= 1 ? portCapacity(port) : undefined,
    });

    // Devices behind this one: clusters side by side, each a small tree in its medium's colour.
    // A curve leaves below the device's label and comes down into the cluster's centre; a branch
    // runs over each row; each device's own link is the drop from its branch.
    if (!clusters.length) return;
    const lineTop = y + 96;
    const rowY = (r: number) => y + 250 + r * KID_ROW_H;
    const branchY = (r: number) => rowY(r) - 70;
    const total = clusters.reduce((w, c) => w + clusterW(c.kids.length), 0) + (clusters.length - 1) * CLUSTER_GAP;
    let left = x - total / 2;
    for (const c of clusters) {
      const w = clusterW(c.kids.length);
      const cols = colsFor(c.kids.length);
      const mid = left + w / 2;
      const rows = Math.ceil(c.kids.length / cols);
      const trunk = vcurve(x, lineTop, mid, branchY(0));
      const tree: string[] = [`${trunk}${rows > 1 ? ` V ${round(branchY(rows - 1))}` : ""}`];
      for (let r = 0; r < rows; r++) {
        const inRow = c.kids.slice(r * cols, (r + 1) * cols);
        const xs = inRow.map((_, j) => mid + (j - (inRow.length - 1) / 2) * KID_W);
        if (inRow.length > 1) tree.push(`M ${round(xs[0]!)} ${round(branchY(r))} H ${round(xs.at(-1)!)}`);
        inRow.forEach((d, j) => {
          const cx = xs[j]!;
          const cy = rowY(r);
          nodes.push({ id: d.id, x: cx, y: cy, kind: d.kind, label: "below" });
          links.push({
            id: `l:${d.id}`,
            from: id,
            to: d.id,
            d: `M ${round(cx)} ${round(branchY(r))} V ${round(cy - 40)}`,
            route: `${trunk}${r > 0 ? ` V ${round(branchY(r))}` : ""} H ${round(cx)} V ${round(cy - 40)}`,
            len: curveLen(x, lineTop, mid, branchY(0)) + (branchY(r) - branchY(0)) + Math.abs(cx - mid) + (cy - 40 - branchY(r)),
            medium: mediumOf(d),
            // The cluster's label says the medium; a lone cable also names its port there.
            label: d.via?.kind === "wifi" || c.kids.length === 1 ? undefined : (d.via?.port ?? ""),
            labelAt: { x: cx + 7, y: branchY(r) + 20, anchor: "start" },
            down: d.via?.downBps,
            up: d.via?.upBps,
            capacity: d.via?.kind === "wifi" ? wifiCapacity(d) : undefined,
          });
        });
      }
      const port = c.kids.length === 1 ? c.kids[0]!.via?.port : undefined;
      const label = c.medium === "wired" ? `Cable · ${port ?? c.kids.length}` : `${c.medium.replace("wifi-", "")} GHz Wi-Fi · ${c.kids.length}`;
      const sum = (k: "downBps" | "upBps") => (c.kids.some((d) => d.via?.[k] !== undefined) ? c.kids.reduce((t, d) => t + (d.via?.[k] ?? 0), 0) : undefined);
      buses.push({ id: `bus:${id}:${c.medium}`, from: id, d: tree.join(" "), medium: c.medium === "wired" ? mediumOf(c.kids[0]!) : c.medium, label, labelAt: { x: left + 6, y: branchY(0) - 12 }, down: sum("downBps"), up: sum("upBps") });
      left += w + CLUSTER_GAP;
    }
  });

  // ---- spine: internet, upstream, gateway ----------------------------------------
  const portByNameL = (n?: string) => ports.find((p) => p.name === n);
  const ix = gx;
  // What the router's WAN port moves is the best view of the internet link: rx comes down, tx goes up.
  const wanP = ports.find((p) => p.name === router?.via?.port);
  nodes.push({ id: "internet", x: ix, y: ROW.internet, kind: "internet", label: "right" });
  if (upstream) {
    nodes.push({ id: "upstream", x: gx, y: ROW.upstream, kind: "isp", label: "right" });
    links.push({ id: "l:upstream", from: "internet", to: "upstream", d: vcurve(ix, ROW.internet + 30, gx, ROW.upstream - 36), len: curveLen(ix, ROW.internet + 30, gx, ROW.upstream - 36), medium: "wan", down: wanP?.rxBps, up: wanP?.txBps });
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
      len: curveLen(gx, fromY, wx, gy - GATEWAY_H / 2 - 4),
      medium: "wan",
      label: [wanPort, speedLabel(ports.find((p) => p.name === wanPort)?.speedMbps), m.wan.doubleNat === true ? "double NAT" : ""].filter(Boolean).join(" · "),
      labelAt: { x: Math.max(gx, wx) + 14, y: (fromY + gy - 34) / 2 + 6, anchor: "start" },
      // The WAN port's tx goes up to the ISP and rx comes down, the other way round from a LAN port.
      down: wanP?.rxBps,
      up: wanP?.txBps,
      capacity: portCapacity(wanP),
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
        links.push({ id: `l:${it.id}`, from: router.id, to: it.id, d: `M ${px} ${gy - GATEWAY_H / 2 - 4} C ${px} ${gy - 120}, ${x} ${y + 150}, ${x} ${y + 76}`, medium: "legacy", len: curveLen(px, gy, x, y + 76) * 1.3, label: it.dev.via!.port, labelAt: { x: (px + x) / 2 - 6, y: gy - 92, anchor: "end" }, down: portByNameL(it.dev.via!.port)?.txBps, up: portByNameL(it.dev.via!.port)?.rxBps });
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
  // Labels and service pills are centred on a node, so the leftmost one needs room too.
  const x0 = Math.min(...xs, ...zones.map((z) => z.x)) - pad - 60;
  const x1 = Math.max(...xs, ...zones.map((z) => z.x + z.w)) + pad + 120;
  const y0 = Math.min(...ys) - 90;
  const y1 = Math.max(...ys) + 120;
  return { nodes, links, buses, zones, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, portX };
}

/** Length of a vcurve, near enough for pacing animation. */
const curveLen = (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x2 - x1, y2 - y1) * 1.08;

function vcurve(x1: number, y1: number, x2: number, y2: number): string {
  const my = (y1 + y2) / 2;
  return `M ${round(x1)} ${round(y1)} C ${round(x1)} ${round(my)}, ${round(x2)} ${round(my)}, ${round(x2)} ${round(y2)}`;
}

const round = (n: number) => Math.round(n * 10) / 10;

export type { Band };
