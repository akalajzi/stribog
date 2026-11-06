// Who a device talks to, from the router's connection tracking table, with names from the
// router's DNS cache. Pure functions over router data; the server reads and records them.
//
// Only routed traffic is tracked: a device talking to another on the same LAN bridge never
// passes the router's firewall and does not appear here.

import { connectionsOf, type NetworkModel } from "./model.ts";
import { inCidr, isPrivateIp } from "./net.ts";
import type { RosRecord } from "./ros.ts";

export interface Flow {
  /** "out": the device opened it; "in": something opened it towards the device (a port forward, another network). */
  direction: "out" | "in";
  protocol: string;
  /** The other end's address. */
  remote: string;
  /** For "out", the remote port; for "in", the device's own port that was reached. */
  port?: number;
  /** What the router's DNS cache says the remote is called, first the name that was asked for. */
  names?: string[];
  /** A device on this network, when the other end is one. */
  remoteDevice?: { id: string; name: string };
  scope: "internet" | "local";
  /** What the port is usually for. A convention, not something the router knows. */
  service?: string;
  /** Bytes towards the device and from it. */
  down: number;
  up: number;
  connections: number;
  /** Some of these connections are fast-tracked, so the router may count only part of their bytes. */
  fasttracked?: boolean;
  /** Who runs the other end's network (from an ASN database, not the router). */
  owner?: { asn: number; name: string; country?: string };
  /** The other end's reverse-DNS name, when it has one. */
  ptr?: string;
}

/** Traffic grouped by who runs the other end: the device's top talkers. */
export interface OwnerShare {
  name: string;
  asn?: number;
  country?: string;
  down: number;
  up: number;
  /** Of all bytes in the list it was made from, 0..1. */
  share: number;
  addresses: number;
  ports: string[];
}

/** Group flows by network owner (or "this network", broadcast...), biggest first. */
export function byOwner(rows: Pick<Flow, "remote" | "port" | "protocol" | "scope" | "owner" | "names" | "down" | "up">[]): OwnerShare[] {
  const total = rows.reduce((t, r) => t + r.down + r.up, 0) || 1;
  const groups = new Map<string, OwnerShare & { ips: Set<string>; portSet: Set<string> }>();
  for (const r of rows) {
    const special = specialAddress(r.remote);
    const name = r.owner?.name ?? (special ? "Broadcast and multicast" : r.scope === "local" ? "This network" : "Unknown network");
    // One organisation often runs several networks (ASNs); people think of it as one.
    const key = name;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { name, asn: r.owner?.asn, country: r.owner?.country, down: 0, up: 0, share: 0, addresses: 0, ports: [], ips: new Set(), portSet: new Set() }));
    g.down += r.down;
    g.up += r.up;
    g.ips.add(r.remote);
    if (r.port) g.portSet.add(`${r.port}/${r.protocol}`);
  }
  return [...groups.values()]
    .map(({ ips, portSet, ...g }) => ({ ...g, share: (g.down + g.up) / total, addresses: ips.size, ports: [...portSet].slice(0, 6) }))
    .sort((a, b) => b.down + b.up - (a.down + a.up));
}

/** Well-known ports. Standard assignments, shown as "usually". */
const SERVICES: Record<string, string> = {
  "tcp/22": "SSH",
  "tcp/25": "mail (SMTP)",
  "udp/53": "DNS",
  "tcp/53": "DNS",
  "udp/67": "DHCP",
  "tcp/80": "web (HTTP)",
  "udp/123": "time (NTP)",
  "tcp/443": "web (HTTPS)",
  "udp/443": "web (HTTP/3, QUIC)",
  "tcp/445": "file sharing (SMB)",
  "tcp/465": "mail (SMTPS)",
  "tcp/587": "mail (submission)",
  "tcp/853": "encrypted DNS (DoT)",
  "udp/853": "encrypted DNS (DoQ)",
  "tcp/993": "mail (IMAPS)",
  "udp/1900": "device discovery (SSDP)",
  "tcp/1883": "MQTT",
  "udp/3478": "calls / NAT traversal (STUN)",
  "tcp/5223": "Apple push",
  "tcp/5228": "Google push",
  "udp/5353": "local discovery (mDNS)",
  "tcp/8080": "web (alternate)",
  "tcp/8443": "web (alternate HTTPS)",
  "tcp/8883": "MQTT over TLS",
  "udp/51820": "WireGuard",
};

export const serviceOf = (protocol: string, port?: number) => (port ? SERVICES[`${protocol}/${port}`] : undefined);

/** "192.0.2.7:443" → ["192.0.2.7", 443]. ICMP and friends have no port. */
export function splitAddr(a?: string): [string, number | undefined] {
  if (!a) return ["", undefined];
  const m = /^(.*):(\d+)$/.exec(a);
  return m && m[1]!.includes(".") ? [m[1]!, Number(m[2])] : [a, undefined];
}

/**
 * Address → names, from the DNS cache. CNAME chains are walked back so the name a device
 * actually asked for comes first ("api.vendor.com" before "edge-17.cdn.net").
 */
export function namesByAddress(cache: RosRecord[]): Map<string, string[]> {
  const parentOf = new Map<string, string>();
  for (const r of cache) if (r.type === "CNAME" && r.name && r.data) parentOf.set(r.data.replace(/\.$/, ""), r.name.replace(/\.$/, ""));
  const out = new Map<string, string[]>();
  for (const r of cache) {
    if ((r.type !== "A" && r.type !== "AAAA") || !r.name || !r.data) continue;
    const chain = [r.name.replace(/\.$/, "")];
    for (let n = parentOf.get(chain[0]!), i = 0; n && i < 8 && !chain.includes(n); n = parentOf.get(n), i++) chain.unshift(n);
    const list = out.get(r.data) ?? [];
    for (const n of chain) if (!list.includes(n)) list.push(n);
    out.set(r.data, list);
  }
  return out;
}

/** Addresses that are nobody in particular: broadcast to the whole LAN, or multicast. */
export function specialAddress(ip: string): string | undefined {
  if (ip === "255.255.255.255") return "everyone on the network (broadcast)";
  const first = Number(ip.split(".")[0]);
  if (first >= 224 && first <= 239) return "a group of devices (multicast)";
  return undefined;
}

/** A device's flows right now, grouped by the other end and port, biggest first. */
export function flowsFor(ip: string, conns: RosRecord[], names: Map<string, string[]>, m: NetworkModel): Flow[] {
  const lans = m.networks.filter((n) => n.role !== "wan" && n.cidr).map((n) => n.cidr!);
  const groups = new Map<string, Flow>();
  for (const c of conns) {
    const one = connFlow(ip, c);
    if (!one) continue;
    const key = `${one.direction}|${one.protocol}|${one.remote}|${one.port ?? ""}`;
    let f = groups.get(key);
    if (!f) {
      const dev = m.devices.find((d) => d.mac && connectionsOf(d).some((l) => l.ip === one.remote));
      const special = specialAddress(one.remote);
      const local = !!special || lans.some((cidr) => inCidr(one.remote, cidr)) || (isPrivateIp(one.remote) && !!dev);
      f = {
        direction: one.direction,
        protocol: one.protocol,
        remote: one.remote,
        port: one.port,
        names: special ? [special] : names.get(one.remote),
        remoteDevice: dev ? { id: dev.id, name: dev.name } : undefined,
        scope: local ? "local" : "internet",
        service: serviceOf(one.protocol, one.port),
        down: 0,
        up: 0,
        connections: 0,
      };
      groups.set(key, f);
    }
    f.down += one.down;
    f.up += one.up;
    f.connections++;
    if (one.fasttracked) f.fasttracked = true;
  }
  return [...groups.values()].sort((a, b) => b.down + b.up - (a.down + a.up) || b.connections - a.connections);
}

/** One tracked connection seen from the device at `ip`, or undefined when it is not involved. */
export function connFlow(ip: string, c: RosRecord): { direction: Flow["direction"]; protocol: string; remote: string; port?: number; down: number; up: number; fasttracked: boolean } | undefined {
  // Ports come inside the address ("192.0.2.7:443") or, with a field list, in their own fields.
  const port = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const [src] = splitAddr(c["src-address"]);
  const [dst, dstIn] = splitAddr(c["dst-address"]);
  const [replySrc, replySrcIn] = splitAddr(c["reply-src-address"]);
  const dstPort = dstIn ?? port(c["dst-port"]);
  const replySrcPort = replySrcIn ?? port(c["reply-src-port"]);
  const orig = Number(c["orig-bytes"] ?? 0) || 0;
  const repl = Number(c["repl-bytes"] ?? 0) || 0;
  const protocol = (c.protocol ?? "?").toLowerCase();
  const fasttracked = c.fasttrack === "true" || /fasttrack/.test(c["connection-type"] ?? "");
  if (src === ip) return { direction: "out", protocol, remote: dst, port: dstPort, up: orig, down: repl, fasttracked };
  // Towards the device: directly, or through a destination NAT (a port forward) that the reply reveals.
  if (dst === ip || replySrc === ip) return { direction: "in", protocol, remote: src, port: dst === ip ? dstPort : replySrcPort, up: repl, down: orig, fasttracked };
  return undefined;
}
