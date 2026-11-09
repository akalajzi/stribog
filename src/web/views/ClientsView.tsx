import { useMemo, useState } from "react";
import type { Device, Finding, NetworkPayload, Severity } from "../api.ts";
import { KIND_LABEL, type DeviceKind } from "../../core/classify.ts";
import { SEV_VAR } from "../components/FindingCard.tsx";
import { COLORS, Glyph, bandColor } from "../components/DeviceArt.tsx";
import { SignalBars } from "../components/Inspector.tsx";
import "./clients.css";

type Filter = "all" | "new" | "online" | "wifi" | "wired" | "offline" | "attention";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "new", label: "New" },
  { id: "online", label: "Online" },
  { id: "wifi", label: "Wi-Fi" },
  { id: "wired", label: "Wired" },
  { id: "offline", label: "Offline" },
  { id: "attention", label: "Needs attention" },
];
const SEV_RANK: Severity[] = ["critical", "warning", "suggestion", "info"];
/** "Needs attention" means something to fix; suggestions are ideas and only show as a dot. */
const ATTENTION: Severity[] = ["critical", "warning"];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const minus = (n: number) => String(n).replace("-", "−");

/** "Reserved 10.0.0.5, but currently at 10.0.0.9" → both addresses. */
function reservationDrift(d: Device): { reserved: string; current: string } | undefined {
  for (const f of d.facts) {
    const m = f.match(/^Reserved (\S+), but currently at (\S+)$/);
    if (m) return { reserved: m[1]!, current: m[2]! };
  }
  return undefined;
}

const isInfra = (d: Device) => d.managed || d.kind === "ap" || d.kind === "switch";

/** Devices Stribog would like the user to introduce: guessed names or guessed kinds. */
const needsIntro = (d: Device) => !d.managed && (d.nameSource === "mac" || d.nameSource === "vendor" || d.kind === "unknown" || d.kindCertainty === "inferred");

export function ClientsView({ data, onSelect, initialFilter }: { data: NetworkPayload; onSelect: (id: string) => void; initialFilter?: string }) {
  const { model, analysis } = data;
  const [filter, setFilter] = useState<Filter>(FILTERS.some((f) => f.id === initialFilter) ? (initialFilter as Filter) : "all");
  const [q, setQ] = useState("");

  const skip = new Set(["internet", "upstream", model.routerId ?? "router"]);
  const all = model.devices.filter((d) => d.mac && !skip.has(d.id));
  const byId = (id?: string) => (id ? model.devices.find((d) => d.id === id) : undefined);

  // Findings that name a device, worst first.
  const findingsOf = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const f of analysis.findings) {
      if (f.severity === "pass" || f.accepted) continue;
      for (const id of f.devices ?? []) m.set(id, [...(m.get(id) ?? []), f]);
    }
    for (const list of m.values()) list.sort((a, b) => SEV_RANK.indexOf(a.severity) - SEV_RANK.indexOf(b.severity));
    return m;
  }, [analysis]);

  const attention = (d: Device) => !!reservationDrift(d) || (findingsOf.get(d.id) ?? []).some((f) => ATTENTION.includes(f.severity));
  const matches: Record<Filter, (d: Device) => boolean> = {
    all: () => true,
    new: (d) => !!d.isNew,
    online: (d) => d.status === "online",
    wifi: (d) => d.via?.kind === "wifi",
    wired: (d) => d.via?.kind === "port",
    offline: (d) => d.status === "offline",
    attention,
  };

  const needle = q.trim().toLowerCase();
  const found = (d: Device) =>
    !needle || [d.name, d.ip, d.mac, d.hostname, d.vendor, d.leaseComment, KIND_LABEL[d.kind]].some((v) => v?.toLowerCase().includes(needle));
  const statusRank = (d: Device) => (d.status === "online" ? 0 : d.status === "unknown" ? 1 : 2);
  const visible = all.filter((d) => matches[filter](d) && found(d)).sort((a, b) => statusRank(a) - statusRank(b) || a.name.localeCompare(b.name));
  const groups = [
    { label: "Network gear", list: visible.filter(isInfra) },
    { label: "Devices", list: visible.filter((d) => !isInfra(d)) },
  ].filter((g) => g.list.length);

  // Summary
  const online = all.filter((d) => d.status === "online");
  const wifi = online.filter((d) => d.via?.kind === "wifi");
  const w24 = wifi.filter((d) => d.via?.band === "2.4").length;
  const w5 = wifi.filter((d) => d.via?.band === "5").length;
  const w6 = wifi.filter((d) => d.via?.band === "6").length;
  const priv = all.filter((d) => d.privateMac).length;
  const reserved = all.filter((d) => d.reserved);
  const drifted = all.filter((d) => reservationDrift(d)).length;
  const intro = all.filter(needsIntro);

  return (
    <div className="scroll">
      <div className="page">
        <h1>Clients</h1>
        <p className="lede">
          Everything the router has seen on the network: where it is connected, which address it has, and whether anything about it needs a look. Click a row to see it on the map.
        </p>

        <div className="cl-tiles">
          <div className="card tile">
            <small>Devices</small>
            <b className="mono">{all.length}</b>
            <span>{all.filter(isInfra).length} network gear · {all.filter((d) => !isInfra(d)).length} clients</span>
          </div>
          <div className="card tile">
            <small>Online</small>
            <b className="mono">{online.length}</b>
            <span>{wifi.length} on Wi-Fi · {online.length - wifi.length} wired</span>
          </div>
          <div className="card tile">
            <small>Wi-Fi bands</small>
            <b className="mono cl-bands">
              <span style={{ color: COLORS.w24 }}>{w24}</span>
              <span className="faint">/</span>
              <span style={{ color: COLORS.w5 }}>{w5}</span>
              {w6 > 0 && <><span className="faint">/</span><span style={{ color: COLORS.w6 }}>{w6}</span></>}
            </b>
            <div className="cl-split" aria-hidden>
              {wifi.length ? (
                <>
                  <i style={{ flex: w24, background: COLORS.w24 }} />
                  <i style={{ flex: w5, background: COLORS.w5 }} />
                  <i style={{ flex: w6, background: COLORS.w6 }} />
                </>
              ) : (
                <i style={{ flex: 1, background: "var(--ink-4)" }} />
              )}
            </div>
            <span>2.4 GHz / 5 GHz{w6 ? " / 6 GHz" : ""}</span>
          </div>
          <div className="card tile">
            <small>Private MAC</small>
            <b className="mono">{priv}</b>
            <span title="Random addresses phones and laptops pick for privacy. They can change, which breaks reservations.">randomised for privacy</span>
          </div>
          <div className="card tile">
            <small>Reservations</small>
            <b className="mono">{reserved.length}</b>
            <span>{drifted ? <span style={{ color: "var(--warn)" }}>{drifted} not at their reserved address</span> : "fixed addresses in DHCP"}</span>
          </div>
        </div>

        <div className="cl-bar">
          <div className="filters">
            {FILTERS.map((f) => {
              const n = all.filter(matches[f.id]).length;
              if (f.id !== "all" && !n) return null;
              return (
                <button key={f.id} className={`fchip${filter === f.id ? " on" : ""}`} onClick={() => setFilter(f.id)}>
                  {f.id === "attention" && <span className="dot warn" style={{ boxShadow: "none" }} />}
                  {f.label} <span className="n">{n}</span>
                </button>
              );
            })}
          </div>
          <label className="cl-search">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><circle cx={11} cy={11} r={6.5} /><path d="m16 16 4.5 4.5" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, IP, MAC or hostname" spellCheck={false} />
            {q && <button className="cl-clear" onClick={() => setQ("")} aria-label="Clear search">×</button>}
          </label>
        </div>

        <div className="card cl-table">
          <table className="t">
            <thead>
              <tr>
                <th>Device</th>
                <th>Address</th>
                <th>Connection</th>
                <th>Network</th>
                <th>MAC</th>
                <th style={{ textAlign: "right" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => [
                <tr key={`g-${g.label}`} className="cl-group">
                  <td colSpan={6}>{g.label} <span className="mono">{g.list.length}</span></td>
                </tr>,
                ...g.list.map((d) => <ClientRow key={d.id} d={d} findings={findingsOf.get(d.id) ?? []} byId={byId} routerId={model.routerId} networks={model.networks} onSelect={onSelect} />),
              ])}
              {!groups.length && (
                <tr>
                  <td colSpan={6} className="cl-empty">No devices match{needle ? ` “${q.trim()}”` : ""}.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <MeetPanel devices={intro} onSelect={onSelect} />
      </div>
    </div>
  );
}

function ClientRow({
  d,
  findings,
  byId,
  routerId,
  networks,
  onSelect,
}: {
  d: Device;
  findings: Finding[];
  byId: (id?: string) => Device | undefined;
  routerId?: string;
  networks: NetworkPayload["model"]["networks"];
  onSelect: (id: string) => void;
}) {
  const drift = reservationDrift(d);
  const accent =
    d.status === "offline" ? "var(--tx-3)" : d.via?.kind === "wifi" ? bandColor(d.via.band) : d.zone === "upstream" ? COLORS.up : d.via?.kind === "port" ? COLORS.g1 : "var(--tx-2)";
  const net = networks.find((n) => n.id === d.network);
  const worst = findings[0];
  const showHost = d.hostname && d.hostname.toLowerCase() !== d.name.toLowerCase();

  return (
    <tr className={`cl-row${d.status === "offline" ? " off" : ""}`} onClick={() => onSelect(d.id)}>
      <td className="tx">
        <div className="cl-dev">
          <span className="cl-ic" style={{ color: accent }}><Glyph kind={d.kind} size={17} /></span>
          <span>
            <b>
              {d.name}
              {d.isNew && <span className="cl-new" title={d.firstSeen ? `First seen ${fmtSeen(d.firstSeen)}, and nobody has noted what it is yet.` : undefined}>new</span>}
            </b>
            <span className="cl-sub">
              {KIND_LABEL[d.kind as DeviceKind] ?? d.kind}
              {d.kindCertainty === "inferred" && <span className="cert" title="Stribog guessed this from the name, hostname or maker.">probably</span>}
              {showHost && <span className="mono faint cl-host">{d.hostname}</span>}
            </span>
          </span>
        </div>
      </td>
      <td>
        {drift ? (
          <div className="cl-stack">
            <span className="mono tx1">{drift.current}</span>
            <span className="cl-drift" title={`DHCP reserves ${drift.reserved} for this device, but it is using ${drift.current}. It is probably on another network or got its address elsewhere.`}>
              reserved <span className="mono">{drift.reserved}</span>
            </span>
          </div>
        ) : d.ip ? (
          <div className="cl-stack">
            <span className={`mono${d.status === "offline" ? "" : " tx1"}`}>{d.ip}</span>
            {d.reserved && <span className="cl-tagline">reserved</span>}
          </div>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td><Connection d={d} byId={byId} routerId={routerId} /></td>
      <td>
        {d.zone === "upstream" ? (
          <span className="chip cl-up" title="The ISP router's side, outside the home LAN.">Upstream</span>
        ) : net ? (
          <span className="chip">{net.label}</span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td>
        <div className="cl-stack">
          <span className="mono">{d.mac}</span>
          {d.privateMac ? (
            <span className="cl-tagline" title="A randomised address the device chose for privacy. It can change, which breaks reservations and makes it look like a new device.">private address</span>
          ) : d.vendor ? (
            <span className="cl-tagline">{d.vendor}</span>
          ) : null}
        </div>
      </td>
      <td>
        <div className="cl-status">
          {worst && (
            <span
              className="cl-sev"
              style={{ background: SEV_VAR[worst.severity] }}
              title={findings.map((f) => f.title).join("\n")}
            />
          )}
          {!worst && drift && <span className="cl-sev" style={{ background: "var(--warn)" }} title={`Reserved ${drift.reserved}, but currently at ${drift.current}`} />}
          <span className={`dot${d.status === "online" ? "" : d.status === "offline" ? " off" : " warn"}`} />
          <span className="cl-st">{d.status === "online" ? "Online" : d.status === "offline" ? "Offline" : "Unknown"}</span>
        </div>
      </td>
    </tr>
  );
}

function Connection({ d, byId, routerId }: { d: Device; byId: (id?: string) => Device | undefined; routerId?: string }) {
  const v = d.via;
  const parent = byId(d.parent);
  const probably = v?.certainty === "inferred" && <span className="cert">probably</span>;
  if (v?.kind === "wifi")
    return (
      <div className="cl-stack">
        <span className="cl-line">
          <span className="tx1">{v.ssid ?? "Wi-Fi"}</span>
          {v.band && <span className={`chip band-${v.band}`}>{v.band} GHz</span>}
        </span>
        <span className="cl-line faint">
          <SignalBars dbm={v.signal} />
          {v.signal !== undefined && <span className="mono">{minus(v.signal)} dBm</span>}
          {parent && <span>· {parent.name}</span>}
        </span>
      </div>
    );
  if (v?.kind === "port") {
    const poe = d.facts.some((f) => f.startsWith("Powered over PoE"));
    if (d.parent && d.parent !== routerId)
      return (
        <div className="cl-stack">
          <span className="cl-line"><Cable /><span className="tx1">Behind {parent?.name ?? d.parent}</span>{probably}</span>
          {v.port && <span className="faint">its port <span className="mono">{v.port}</span></span>}
        </div>
      );
    return (
      <div className="cl-stack">
        <span className="cl-line"><Cable /><span className="tx1">Router</span>{v.port && <span className="mono">{v.port}</span>}{probably}</span>
        {(poe || d.zone === "upstream") && <span className="faint">{poe ? "powered over PoE" : "upstream side"}</span>}
      </div>
    );
  }
  if (v?.kind === "upstream")
    return (
      <div className="cl-stack">
        <span className="cl-line"><span className="tx1">Via {parent?.name ?? "the ISP router"}</span>{probably}</span>
        <span className="faint">outside the home LAN</span>
      </div>
    );
  return <span className="faint">{d.status === "offline" ? (d.lastSeen ? `Last seen ${d.lastSeen} ago` : "Not connected") : "—"}</span>;
}

function Cable() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" style={{ color: COLORS.g1, flex: "none" }}>
      <rect x={7} y={3} width={10} height={8} rx={1.5} />
      <path d="M10 6.5v1.5M14 6.5v1.5M12 11v10" />
    </svg>
  );
}

// ---------------------------------------------------------------------------


function introReason(d: Device): string {
  if (d.nameSource === "mac") return d.privateMac ? "Private address, nothing else known" : "Named from its MAC address";
  if (d.nameSource === "vendor") return `Only the maker is known${d.vendor ? ` (${d.vendor})` : ""}`;
  if (d.kind === "unknown") return "Type unknown";
  return `Looks like a ${KIND_LABEL[d.kind].toLowerCase()}, but that is a guess`;
}

function MeetPanel({ devices, onSelect }: { devices: Device[]; onSelect: (id: string) => void }) {
  return (
    <>
      <div className="sec-title">Meet your network <em className="faint">{devices.length ? `${plural(devices.length, "device")} Stribog is unsure about` : "everyone is introduced"}</em></div>
      <div className="card cl-meet">
        <div>
          <p className="cl-meet-lede">
            {devices.length
              ? "Stribog only knows what the router knows: an address, sometimes a hostname or a note. Tell it what these are and they get a proper name, icon and the right checks (a printer that is 2.4 GHz-only by design, for example, is not flagged)."
              : "Every device has a name and a type that came from you or from the router. New devices will show up here when Stribog has to guess."}
          </p>
          {devices.length > 0 && (
            <div className="cl-meet-list">
              {devices.map((d) => (
                <button key={d.id} className="cl-meet-item" onClick={() => onSelect(d.id)}>
                  <span className="cl-ic" style={{ color: d.status === "online" ? "var(--tx-1)" : "var(--tx-3)" }}><Glyph kind={d.kind} size={16} /></span>
                  <span>
                    <b>{d.name}</b>
                    <span className="faint">{introReason(d)}</span>
                  </span>
                  <span className="mono faint cl-meet-mac">{d.mac}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="cl-meet-how">
          <div className="lbl">How to tell Stribog</div>
          <p className="muted">
            Click a device and use <span className="tx1">Notes</span> in the panel on the right: a name, its kind, labels, a short description, what runs on it. The change shows everywhere at once and is kept in
            the history in Settings.
          </p>
          <p className="muted">An agent connected in Settings can do the same over MCP, for example to name everything it recognises in one go.</p>
        </div>
      </div>
    </>
  );
}

export const fmtSeen = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
