import { useMemo, useState, type ReactNode } from "react";
import { isOpen } from "../../core/analyze.ts";
import type { Device, NetworkPayload, Network, Port } from "../api.ts";
import { FindingCard, SEV_VAR } from "../components/FindingCard.tsx";
import { COLORS, Glyph, speedColor } from "../components/DeviceArt.tsx";
import { FW_GROUP_HINT, FW_GROUP_LABEL, summarizeFirewall, type FwGroup, type FwNames, type FwSentence } from "../../core/firewall.ts";
import { inCidr, inPool, intToIp, ipToInt, parseCidr } from "../../core/net.ts";
import type { FwRule, Service } from "../../core/model.ts";
import "./network.css";

// "How is it set up, and what is not ideal": the internet path, each network, the LAN address
// space, the router's ports, who can manage it, and the firewall in plain words.

const RELATED = new Set(["internet", "dns-dhcp", "security", "hardware", "segmentation"]);
const ROLE_LABEL: Record<string, string> = { lan: "Main LAN", guest: "Guest", iot: "IoT", wan: "Upstream", legacy: "Legacy", management: "Management" };

const fmtSpeed = (mbps?: number) => (mbps === undefined ? undefined : mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}G` : `${mbps}M`);
const scrollToFinding = (id: string) => document.getElementById(`f-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });

export function NetworkView({ data, onSelect }: { data: NetworkPayload; onSelect: (id: string) => void }) {
  const { model, analysis } = data;
  const dev = (id?: string) => model.devices.find((d) => d.id === id);
  const lan = model.networks.find((n) => n.role === "lan");
  const findings = analysis.findings.filter((f) => RELATED.has(f.category));
  const open = findings.filter(isOpen);
  const good = findings.filter((f) => f.severity === "pass");

  // Friendly names for the firewall sentences: interfaces, networks and known addresses.
  const names = useMemo(() => {
    const n: FwNames = {};
    for (const net of model.networks) {
      n[net.name] = net.label;
      if (net.cidr) n[net.cidr] = net.label;
    }
    for (const d of model.devices) if (d.ip && d.id !== "router") n[d.ip] = d.name;
    return n;
  }, [model]);

  return (
    <div className="scroll">
      <div className="page nv">
        <h1>LAN &amp; internet</h1>
        <p className="lede">
          How this network reaches the internet, how addresses are handed out, and who is allowed to talk to the router. Everything here is read from
          the router's configuration; the review notes at the bottom say what is worth changing.
        </p>

        <InternetPath data={data} />

        <div className="sec-title">Networks <em className="faint">{model.networks.length}</em></div>
        <div className="nv-nets">
          {model.networks.map((n) => <NetworkCard key={n.id} n={n} data={data} onSelect={onSelect} />)}
        </div>

        {lan?.cidr && (
          <>
            <div className="sec-title">Address map <em className="faint">{lan.label} · <span className="mono">{lan.cidr}</span></em></div>
            <AddressMap lan={lan} data={data} onSelect={onSelect} />
          </>
        )}

        <div className="sec-title">Router ports <em className="faint">{dev(model.routerId)?.model ?? ""}</em></div>
        <PortPanel ports={model.ports} data={data} onSelect={onSelect} />

        {model.services && (
          <>
            <div className="sec-title">Management &amp; services</div>
            <Services services={model.services} fw={model.firewall?.filter} />
          </>
        )}

        {model.firewall && (
          <>
            <div className="sec-title">Firewall in plain language <em className="faint">{model.firewall.filter.length + model.firewall.nat.length} rules</em></div>
            <Firewall fw={model.firewall} names={names} />
          </>
        )}

        <div className="sec-title">What to look at <em className="faint">internet, addresses, security, ports and separation</em></div>
        <div style={{ display: "grid", gap: 8 }}>
          {open.map((f) => <FindingCard key={f.id} f={f} deviceName={(id) => dev(id)?.name ?? id} />)}
          {!open.length && <div className="card muted">Nothing to change in these areas.</div>}
        </div>
        {good.length > 0 && (
          <div className="nv-good">
            {good.map((f) => (
              <span key={f.id} title={f.summary}><i style={{ background: SEV_VAR.pass }} />{f.title}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internet path

interface Hop {
  key: string;
  glyph: string;
  title: string;
  sub?: ReactNode;
  nat?: boolean;
  id?: string;
}

function InternetPath({ data }: { data: NetworkPayload }) {
  const { model, analysis } = data;
  const wan = model.wan;
  const up = model.devices.find((d) => d.id === "upstream");
  const router = model.devices.find((d) => d.id === model.routerId);
  const lan = model.networks.find((n) => n.role === "lan");
  const isp = up?.facts.find((f) => f.startsWith("ISP:"))?.replace("ISP: ", "");
  const masq = model.firewall ? model.firewall.nat.some((r) => !r.disabled && r.action === "masquerade") : true;
  const finding = analysis.findings.find((f) => f.id === "wan-double-nat");
  const online = model.devices.filter((d) => d.zone === "lan" && d.mac && d.status === "online").length;
  const lanCount = model.devices.filter((d) => d.zone === "lan" && d.mac).length;

  const hops: Hop[] = [{ key: "internet", glyph: "internet", title: "Internet", sub: isp ?? "Your ISP" }];
  const links: { label: string; addr?: string }[] = [];
  if (wan.addressKind === "cgnat") {
    links.push({ label: "public address" });
    hops.push({ key: "cgnat", glyph: "isp", title: "Carrier NAT", sub: "inside the ISP", nat: true });
  }
  if (up) {
    links.push({ label: wan.doubleNat === true ? "public address" : "", addr: undefined });
    hops.push({ key: "upstream", id: "upstream", glyph: "isp", title: up.name, sub: <span className="mono">{up.ip ?? "ISP router"}</span>, nat: wan.doubleNat === true });
  }
  links.push({ label: wan.doubleNat === true ? "ISP's private network" : wan.addressKind === "public" ? "public address" : "WAN", addr: wan.address });
  hops.push({
    key: "router",
    id: model.routerId,
    glyph: "router",
    title: router?.name ?? "This router",
    sub: (
      <>
        WAN <span className="mono">{wan.iface ?? "?"}</span> · {wan.type === "unknown" ? "?" : wan.type.toUpperCase()}
      </>
    ),
    nat: masq,
  });
  links.push({ label: "your network", addr: lan?.cidr });
  hops.push({ key: "lan", glyph: "laptop", title: lan?.label ?? "LAN", sub: <>{lanCount} devices{model.hasState ? <> · {online} online</> : null}</> });

  const nats = hops.filter((h) => h.nat).length;
  return (
    <div className="card nv-path">
      <div className="nv-hops">
        {hops.map((h, i) => (
          <div key={h.key} className="nv-hopwrap">
            {i > 0 && (
              <div className="nv-link">
                <span className="lab">{links[i - 1]?.label}</span>
                <span className="line" />
                {links[i - 1]?.addr && <span className="addr mono">{links[i - 1]?.addr}</span>}
              </div>
            )}
            <div className={`nv-hop${h.key === "router" ? " me" : ""}`}>
              {h.nat && <span className={`nv-nat${nats > 1 ? " warn" : ""}`} title="This hop rewrites addresses (NAT)">NAT</span>}
              <span className="ic"><Glyph kind={h.glyph} size={20} /></span>
              <b>{h.title}</b>
              <small>{h.sub}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="nv-path-text">
        {nats > 1 ? (
          <p>
            <b style={{ color: "var(--warn)" }}>Double NAT.</b> Your traffic is translated twice: once by this router and again by {up?.name ?? "the ISP"}. Browsing, streaming and
            calls work fine. What gets awkward is anything that must be reached from outside: port forwards and VPN servers need rules on both boxes, game consoles report a
            strict NAT, and the ISP router's own Wi-Fi sits outside your firewall.{" "}
            {finding && <a href={`#f-${finding.id}`} onClick={(e) => { e.preventDefault(); scrollToFinding(finding.id); }}>How to fix it ↓</a>}
          </p>
        ) : nats === 1 ? (
          <p>
            <b style={{ color: "var(--ok)" }}>Single NAT.</b> Only this router translates addresses{wan.address ? <> and it holds the public address <span className="mono">{wan.address}</span></> : null}, so port forwards and VPNs need just one rule.
          </p>
        ) : (
          <p className="muted">No address translation found on this router. That is normal only if it is a plain switch or access point behind another router.</p>
        )}
        <p className="faint">NAT (network address translation) lets many devices share one internet address: on the way out, the router swaps each device's private address for its own.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Networks

function NetworkCard({ n, data, onSelect }: { n: Network; data: NetworkPayload; onSelect: (id: string) => void }) {
  const { model } = data;
  const devs = model.devices.filter((d) => d.network === n.id && d.mac);
  const d = n.dhcp;
  const wan = n.role === "wan";
  const devByIp = (ip: string) => model.devices.find((x) => x.ip === ip && x.id !== "router" && x.zone === "lan");
  const pct = d && d.used !== undefined && d.size ? Math.min(100, (d.used / d.size) * 100) : undefined;
  const barColor = pct === undefined ? "var(--tx-3)" : pct > 85 ? "var(--bad)" : pct > 65 ? "var(--warn)" : "var(--g1)";
  return (
    <div className={`card nv-net role-${n.role}`}>
      <div className="nv-net-h">
        <div>
          <b>{n.label}</b>
          <div className="faint" style={{ fontSize: 12 }}>{n.comment && n.comment !== n.label ? n.comment : `bridge ${n.bridge}`}</div>
        </div>
        <span className={`chip nv-role role-${n.role}`}>{ROLE_LABEL[n.role] ?? n.role}</span>
      </div>
      <div className="kv">
        <span>Interface</span><span className="tx mono">{n.bridge}{n.vlan ? ` · VLAN ${n.vlan}` : ""}</span>
        {wan ? (
          <>
            <span>Address</span><span className="tx mono">{model.wan.address ?? "from DHCP"}</span>
            {model.wan.gateway && (<><span>Gateway</span><span className="tx mono">{model.wan.gateway}</span></>)}
            <span>Purpose</span><span>Connection to the ISP router{devs.length ? `, plus ${devs.length} device${devs.length === 1 ? "" : "s"} still on the old network` : ""}</span>
          </>
        ) : (
          <>
            <span>Subnet</span><span className="tx mono">{n.cidr ?? "—"}</span>
            <span>Gateway</span><span className="tx mono">{n.gateway ?? "—"}</span>
          </>
        )}
        {d && (
          <>
            <span>DHCP pool</span>
            <span>
              <span className="tx mono">{d.pool.join(", ")}</span>
              <span className="nv-bar" title={d.used !== undefined ? `${d.used} of ${d.size} in use` : `${d.size} addresses`}>
                <i style={{ width: `${pct ?? 0}%`, background: barColor }} />
              </span>
              <span className="faint" style={{ fontSize: 12 }}>
                {d.used !== undefined ? <><span className="mono">{d.used}</span> of <span className="mono">{d.size}</span> in use</> : <><span className="mono">{d.size}</span> addresses</>}
              </span>
            </span>
            <span>Lease time</span><span className="tx">{humanDuration(d.leaseTime)}</span>
            <span>DNS</span>
            <span>
              {d.dns.length ? d.dns.map((ip) => {
                const host = devByIp(ip);
                const isGw = ip === n.gateway;
                return (
                  <span key={ip} className="nv-dns">
                    <span className="tx mono">{ip}</span>
                    {host ? <button className="nv-link-btn" onClick={() => onSelect(host.id)}>{host.name}</button> : isGw ? <span className="faint">this router</span> : <span className="faint">external</span>}
                  </span>
                );
              }) : <span style={{ color: "var(--warn)" }}>none handed out</span>}
              {d.dns.length === 1 && !(d.dns[0] === n.gateway) && <span className="chip nv-warnchip" title="If this one server stops, every device loses name resolution.">single server</span>}
            </span>
            {d.ntp.length > 0 && (<><span>Time (NTP)</span><span className="tx mono">{d.ntp.join(", ")}{d.ntp.includes(n.gateway ?? "") ? <span className="faint" style={{ fontFamily: "var(--sans)" }}> · this router</span> : null}</span></>)}
          </>
        )}
        {!wan && !d && (<><span>DHCP</span><span className="faint">no DHCP server; devices need fixed addresses</span></>)}
        {n.ssids.length > 0 && (<><span>Wi-Fi</span><span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{n.ssids.map((s) => <span key={s} className="chip">{s}</span>)}</span></>)}
        <span>Devices</span>
        <span className="tx"><span className="mono">{devs.length}</span>{model.hasState ? <span className="faint"> · {devs.filter((x) => x.status === "online").length} online</span> : null}</span>
      </div>
    </div>
  );
}

function humanDuration(v?: string): string {
  if (!v) return "—";
  const m = v.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return v;
  const parts = [["week", m[1]], ["day", m[2]], ["hour", m[3]], ["minute", m[4]], ["second", m[5]]].filter(([, n]) => n && n !== "0").map(([u, n]) => `${n} ${u}${n === "1" ? "" : "s"}`);
  return parts.join(" ") || v;
}

// ---------------------------------------------------------------------------
// Address map: the LAN /24 as a 16×16 grid

type CellKind = "net" | "bcast" | "gw" | "res-on" | "res-off" | "res-away" | "dyn" | "manual" | "pool" | "free";

interface Cell {
  i: number;
  ip: string;
  kind: CellKind;
  devs: Device[];
  dns: boolean;
  conflict: boolean;
}

const CELL_LABEL: Record<CellKind, string> = {
  net: "Network address (not usable)",
  bcast: "Broadcast address (not usable)",
  gw: "Gateway: this router",
  "res-on": "Reserved, device online",
  "res-off": "Reserved, device not seen",
  "res-away": "Reserved, but the device is elsewhere",
  dyn: "Handed out from the pool",
  manual: "In use, not from DHCP",
  pool: "Free in the DHCP pool",
  free: "Unused",
};

function AddressMap({ lan, data, onSelect }: { lan: Network; data: NetworkPayload; onSelect: (id: string) => void }) {
  const { model } = data;
  const [hover, setHover] = useState<Cell>();
  const c = parseCidr(lan.gateway ?? lan.cidr!)!;
  const base = ((ipToInt(lan.gateway ?? "") ?? c.network) & 0xffffff00) >>> 0;
  const pool = lan.dhcp?.pool ?? [];
  const dns = new Set(lan.dhcp?.dns ?? []);
  const hasState = model.hasState;

  const cells = useMemo(() => {
    const lanDevs = model.devices.filter((d) => d.mac && d.ip && inCidr(d.ip, lan.cidr!));
    // Reservations whose device currently sits elsewhere (another network or a different address).
    const away = new Map<string, Device>();
    for (const d of model.devices) {
      const m = d.facts.map((f) => f.match(/^Reserved (\S+), but currently at/)).find(Boolean);
      if (m?.[1] && inCidr(m[1], lan.cidr!)) away.set(m[1], d);
    }
    const out: Cell[] = [];
    for (let i = 0; i < 256; i++) {
      const ip = intToIp(base + i);
      const devs = lanDevs.filter((d) => d.ip === ip);
      const inP = inPool(ip, pool);
      let kind: CellKind = inP ? "pool" : "free";
      const d = devs[0];
      if (ip === lan.gateway) kind = "gw";
      else if (i === 0 && c.prefix >= 24) kind = "net";
      else if (i === 255 && c.prefix >= 24) kind = "bcast";
      else if (d) {
        const online = d.status === "online";
        if (d.reserved) kind = online || !hasState ? "res-on" : "res-off";
        else kind = inP ? "dyn" : "manual";
      } else if (away.has(ip)) {
        kind = "res-away";
        devs.push(away.get(ip)!);
      }
      out.push({ i, ip, kind, devs, dns: dns.has(ip), conflict: !!d?.reserved && inP });
    }
    return out;
  }, [model, lan, base, pool, hasState, dns, c.prefix]);

  const count = (k: CellKind) => cells.filter((x) => x.kind === k).length;
  const legend: [CellKind, string][] = [
    ["gw", "Router"],
    ["res-on", hasState ? "Reserved, online" : "Reserved"],
    ...(hasState ? ([["res-off", "Reserved, not seen"]] as [CellKind, string][]) : []),
    ["res-away", "Reserved, device elsewhere"],
    ["dyn", "Dynamic, in use"],
    ["manual", "Fixed, not via DHCP"],
    ["pool", "Free in pool"],
  ];
  const shown = hover ?? undefined;
  const firstDev = shown?.devs[0];

  return (
    <div className="card nv-amap">
      <div className="nv-grid-wrap">
        <div className="nv-cols mono">{Array.from({ length: 16 }, (_, i) => <span key={i}>{i}</span>)}</div>
        <div className="nv-grid-rows">
          <div className="nv-rows mono">{Array.from({ length: 16 }, (_, r) => <span key={r}>.{r * 16}</span>)}</div>
          <div className="nv-grid" onMouseLeave={() => setHover(undefined)}>
            {cells.map((cell) => {
              const d = cell.devs[0];
              const title = `${cell.ip} · ${CELL_LABEL[cell.kind]}${cell.devs.length ? ` · ${cell.devs.map((x) => x.name).join(", ")}` : ""}${cell.dns ? " · DNS server" : ""}`;
              const clickable = !!d || cell.kind === "gw";
              return (
                <button
                  key={cell.i}
                  className={`nv-cell k-${cell.kind}${cell.conflict ? " conflict" : ""}${hover?.i === cell.i ? " hov" : ""}`}
                  title={title}
                  onMouseEnter={() => setHover(cell)}
                  onFocus={() => setHover(cell)}
                  onClick={() => clickable && onSelect(cell.kind === "gw" ? model.routerId ?? "router" : d!.id)}
                  style={{ cursor: clickable ? "pointer" : "default" }}
                >
                  {cell.kind === "gw" ? <Glyph kind="router" size={13} /> : d ? <Glyph kind={d.kind} size={13} /> : null}
                  {cell.dns && <i className="dnsdot" />}
                </button>
              );
            })}
          </div>
        </div>
        <div className="nv-pool-axis faint">
          Pool: <span className="mono">{pool.join(", ") || "none"}</span>
        </div>
      </div>
      <div className="nv-amap-side">
        <div className="nv-detail">
          {shown ? (
            <>
              <div className="mono nv-ip">{shown.ip}</div>
              <div className={`nv-kind k-${shown.kind}`}><i />{CELL_LABEL[shown.kind]}</div>
              {shown.devs.map((d) => (
                <div key={d.id} className="nv-dev">
                  <Glyph kind={d.kind} size={16} />
                  <div>
                    <b>{d.name}</b>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {d.status === "online" ? "online" : d.status === "offline" ? "not seen" : d.status}
                      {d.ip && d.ip !== shown.ip ? <> · now at <span className="mono">{d.ip}</span></> : null}
                      {d.privateMac ? " · private MAC" : ""}
                    </div>
                  </div>
                </div>
              ))}
              {shown.kind === "gw" && <div className="faint" style={{ fontSize: 12 }}>{model.devices.find((x) => x.id === model.routerId)?.name}</div>}
              {shown.dns && <div className="faint" style={{ fontSize: 12 }}>Handed out as DNS server{dns.size === 1 ? " (the only one)" : ""}.</div>}
              {shown.conflict && <div style={{ color: "var(--warn)", fontSize: 12 }}>This reservation sits inside the pool; DHCP could give it to another device.</div>}
              {firstDev || shown.kind === "gw" ? <div className="faint" style={{ fontSize: 11.5 }}>Click to open it on the map.</div> : null}
            </>
          ) : (
            <>
              <div className="lbl" style={{ marginBottom: 6 }}>256 addresses</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Fixed addresses (reservations) live outside the pool; the pool is what DHCP hands to everything else. Hover a square for details.
              </div>
            </>
          )}
        </div>
        <div className="nv-legend">
          {legend.filter(([k]) => count(k) > 0 || k === "gw" || k === "pool" || k === "dyn").map(([k, label]) => (
            <div key={k}><span className={`nv-cell sw k-${k}`} /><span>{label}</span><b className="mono">{count(k)}</b></div>
          ))}
          <div><span className="nv-cell sw k-free"><i className="dnsdot" /></span><span>DNS server</span><b className="mono">{cells.filter((x) => x.dns).length}</b></div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Router ports as a front panel

function PortPanel({ ports, data, onSelect }: { ports: Port[]; data: NetworkPayload; onSelect: (id: string) => void }) {
  const { model } = data;
  const dev = (id: string) => model.devices.find((d) => d.id === id);
  const totalPoe = ports.reduce((s, p) => s + (p.poeWatts ?? 0), 0);
  return (
    <div className="nv-panel">
      <div className="nv-ports">
        {ports.map((p) => {
          const col = speedColor(p);
          const planned = p.planned ? model.planned.find((x) => x.id === p.planned) : undefined;
          const up = p.zone === "upstream";
          const linkText = p.running === false ? "no link" : p.speedMbps !== undefined ? fmtSpeed(p.speedMbps) : p.running ? "link" : model.hasState ? "no link" : "";
          return (
            <div key={p.name} className={`nv-port${p.running === false ? " down" : ""}${up ? " up" : ""}`}>
              <div className="nv-port-top">
                <span className="mono nv-port-n">{p.kind === "sfp" ? "SFP+" : p.name.replace(/^\D+/, "")}</span>
                {p.poeWatts ? <span className="nv-poe mono" title={`PoE out: ${p.poeVolts ?? "?"} V`}>⚡{p.poeWatts} W</span> : p.poe && p.poe !== "off" ? <span className="nv-poe off" title={`PoE ${p.poe}`}>PoE</span> : null}
              </div>
              <div className={`nv-jack${p.kind === "sfp" ? " sfp" : ""}`}>
                <span className="led" style={{ background: col ?? "transparent", boxShadow: col ? `0 0 8px ${col}` : "none" }} />
              </div>
              <div className="nv-port-meta">
                <span className="mono" style={{ color: col ?? "var(--tx-3)" }}>{linkText || "—"}</span>
                <span className={`nv-zone${up ? " up" : ""}`}>{up ? "Upstream" : p.zone === "lan" ? "LAN" : "unused"}</span>
              </div>
              {p.comment && <div className="nv-port-c" title={p.comment}>{p.comment}</div>}
              <div className="nv-port-devs">
                {p.deviceIds.map((id) => {
                  const d = dev(id);
                  return d ? (
                    <button key={id} className="nv-pd" onClick={() => onSelect(id)} title={d.ip}>
                      <Glyph kind={d.kind} size={12} />{d.name}
                    </button>
                  ) : null;
                })}
                {planned && !p.deviceIds.length && (
                  <span className="nv-pd planned" title={planned.note}>
                    <Glyph kind={planned.kind} size={12} color={COLORS.w5} />{planned.name}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="nv-panel-foot faint">
        <span><i style={{ background: COLORS.mg }} />2.5G+</span>
        <span><i style={{ background: COLORS.g1 }} />1G</span>
        <span><i style={{ background: COLORS.warn }} />slower than 1G</span>
        <span><i style={{ background: COLORS.up }} />to the ISP</span>
        <span><i style={{ border: `1px dashed ${COLORS.w5}`, background: "transparent" }} />planned</span>
        {totalPoe > 0 && <span style={{ marginLeft: "auto" }}>PoE out <b className="mono" style={{ color: "var(--tx-2)" }}>{+totalPoe.toFixed(1)} W</b></span>}
        {!model.hasState && <span style={{ marginLeft: "auto" }}>Link speeds need a live connection</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Management services

const SVC: Record<string, { label: string; what: string; risk: "clear" | "ok" | "api" }> = {
  www: { label: "WebFig", what: "Web admin over plain HTTP", risk: "clear" },
  "www-ssl": { label: "WebFig HTTPS", what: "Web admin, encrypted; needs a certificate", risk: "ok" },
  ssh: { label: "SSH", what: "Terminal, encrypted", risk: "ok" },
  winbox: { label: "WinBox", what: "MikroTik's admin app, encrypted", risk: "ok" },
  api: { label: "API", what: "For scripts and apps, unencrypted", risk: "api" },
  "api-ssl": { label: "API-SSL", what: "For scripts and apps, encrypted", risk: "api" },
  ftp: { label: "FTP", what: "File transfer, passwords in clear text", risk: "clear" },
  telnet: { label: "Telnet", what: "Terminal, passwords in clear text", risk: "clear" },
};

function Services({ services, fw }: { services: Service[]; fw?: FwRule[] }) {
  const on = services.filter((s) => s.enabled);
  const open = on.filter((s) => !s.address);
  const wanBlocked = !!fw?.some((r) => !r.disabled && r.chain === "input" && (r.action === "drop" || r.action === "reject") && (r["in-interface-list"] === "!LAN" || r["in-interface-list"] === "WAN" || (!r["in-interface-list"] && !r["in-interface"] && !r["src-address"] && !r.protocol)));
  const note = (s: Service): { text: string; tone: "bad" | "warn" | "ok" | "faint" } => {
    const meta = SVC[s.name];
    if (!s.enabled) return { text: meta?.risk === "clear" ? "Off, as it should be." : "Off.", tone: "faint" };
    if (meta?.risk === "clear" && s.name !== "www") return { text: "Sends passwords in clear text. Turn it off.", tone: "bad" };
    if (s.name === "www") return { text: s.address ? "Unencrypted, but only reachable from the allowed addresses." : "Your admin password crosses the network unencrypted. Restrict it, or use WinBox/HTTPS.", tone: s.address ? "ok" : "warn" };
    if (meta?.risk === "api") return { text: "Only needed by apps that manage the router. Off if you do not use one.", tone: "warn" };
    return { text: s.address ? "Encrypted and limited to the allowed addresses." : "Encrypted, but any device on the LAN can try to log in.", tone: s.address ? "ok" : "warn" };
  };
  return (
    <div className="card nv-svc">
      <p className="muted" style={{ margin: "0 0 12px" }}>
        <b style={{ color: "var(--tx-1)" }}>{on.length} management service{on.length === 1 ? "" : "s"} on</b>
        {open.length ? `, ${open.length === on.length ? "none" : `${on.length - open.length}`} limited to specific addresses.` : ", all limited to specific addresses."}{" "}
        {wanBlocked ? "The firewall already keeps them away from the internet side; this is about which devices inside may try." : <span style={{ color: "var(--warn)" }}>No firewall rule clearly blocks them from the internet side.</span>}
      </p>
      <table className="t">
        <thead><tr><th>Service</th><th>Port</th><th>State</th><th>Allowed from</th><th>In plain words</th></tr></thead>
        <tbody>
          {services.map((s) => {
            const n = note(s);
            return (
              <tr key={s.name} className={s.enabled ? undefined : "off"}>
                <td className="tx"><b style={{ fontWeight: 500 }}>{SVC[s.name]?.label ?? s.name}</b><div className="faint" style={{ fontSize: 11.5 }}>{SVC[s.name]?.what ?? ""}</div></td>
                <td className="mono">{s.port ?? ""}</td>
                <td><span className="nv-state"><i className={`dot${s.enabled ? "" : " off"}`} />{s.enabled ? "On" : "Off"}</span></td>
                <td className="mono">{s.enabled ? (s.address ?? <span style={{ color: "var(--warn)", fontFamily: "var(--sans)" }}>any address</span>) : "—"}</td>
                <td style={{ color: n.tone === "bad" ? "var(--bad)" : n.tone === "warn" ? "var(--warn)" : n.tone === "ok" ? "var(--ok)" : "var(--tx-3)" }}>{n.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Firewall

const VERDICT_COLOR: Record<FwSentence["verdict"], string> = { allow: "var(--ok)", drop: "var(--bad)", nat: "var(--mg)", speed: "var(--g1)", other: "var(--tx-3)" };
const RAW_ORDER = ["chain", "action", "connection-state", "connection-nat-state", "protocol", "src-address", "src-port", "dst-address", "dst-port", "in-interface", "in-interface-list", "out-interface", "out-interface-list", "ipsec-policy", "to-addresses", "to-ports"];

function rawRule(r: FwRule): string {
  const rec = r as unknown as Record<string, string | boolean | undefined>;
  return RAW_ORDER.filter((k) => rec[k]).map((k) => `${k}=${rec[k]}`).join(" ") + (r.disabled ? " disabled=yes" : "");
}

function Firewall({ fw, names }: { fw: { filter: FwRule[]; nat: FwRule[] }; names: FwNames }) {
  const [raw, setRaw] = useState(false);
  const groups = useMemo(() => summarizeFirewall(fw, names), [fw, names]);
  const order: FwGroup[] = ["input", "forward", "nat", "other"];
  const temp = [...groups.input, ...groups.forward, ...groups.nat, ...groups.other].filter((s) => s.temporary && !s.disabled).length;
  return (
    <div className="nv-fw">
      <div className="nv-fw-bar">
        <span className="muted">
          Read top to bottom: the first rule that matches decides.{" "}
          {temp > 0 && <span style={{ color: "var(--warn)" }}>{temp} temporary rule{temp === 1 ? " is" : "s are"} still active.</span>}
        </span>
        <div className="seg">
          <button className={raw ? undefined : "on"} onClick={() => setRaw(false)}>Plain</button>
          <button className={raw ? "on" : undefined} onClick={() => setRaw(true)}>With RouterOS</button>
        </div>
      </div>
      <div className="nv-fw-groups">
        {order.map((g) =>
          groups[g].length ? (
            <div key={g} className="card nv-fw-group">
              <div className="nv-fw-h">
                <b>{FW_GROUP_LABEL[g]}</b>
                <span className="faint">{FW_GROUP_HINT[g]}</span>
              </div>
              <ol>
                {groups[g].map((s) => (
                  <li key={`${g}-${s.index}`} className={`${s.disabled ? "dis" : ""}${s.temporary && !s.disabled ? " temp" : ""}`}>
                    <span className="n mono">{s.index}</span>
                    <span className="v" style={{ background: VERDICT_COLOR[s.verdict] }} />
                    <div className="body">
                      <div className="txt">
                        {s.text}
                        {s.isDefault && <span className="chip nv-tag">default</span>}
                        {s.disabled && <span className="chip nv-tag">disabled</span>}
                      </div>
                      {s.note && !s.disabled && <div className="note">{s.note}</div>}
                      {raw && <div className="raw mono">{rawRule(s.rule)}{s.rule.comment ? <span className="faint">  # {s.rule.comment}</span> : null}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : null,
        )}
      </div>
      <div className="nv-fw-legend faint">
        <span><i style={{ background: VERDICT_COLOR.allow }} />allows</span>
        <span><i style={{ background: VERDICT_COLOR.drop }} />blocks</span>
        <span><i style={{ background: VERDICT_COLOR.nat }} />translates</span>
        <span><i style={{ background: VERDICT_COLOR.speed }} />speeds up</span>
      </div>
    </div>
  );
}

