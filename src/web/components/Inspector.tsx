import type { Device, NetworkPayload } from "../api.ts";
import { KIND_LABEL, type DeviceKind } from "../../core/classify.ts";
import { bandColor, Glyph } from "./DeviceArt.tsx";
import { SEV_VAR } from "./FindingCard.tsx";

export function SignalBars({ dbm }: { dbm?: number }) {
  const n = dbm === undefined ? 0 : dbm >= -55 ? 4 : dbm >= -62 ? 3 : dbm >= -70 ? 2 : 1;
  return (
    <span className="sig">
      {[4, 7, 10, 12].map((h, i) => <i key={i} className={i < n ? "on" : undefined} style={{ height: h }} />)}
    </span>
  );
}

const certLabel = (c?: string) => (c === "inferred" ? "probably" : c === "user" ? "you said" : undefined);

export function Inspector({ data, id, onClose, onSelect, onFinding }: { data: NetworkPayload; id: string; onClose: () => void; onSelect: (id: string) => void; onFinding: (fid: string) => void }) {
  const { model, analysis } = data;
  const planned = model.planned.find((p) => `planned:${p.id}` === id);
  if (planned) {
    const port = model.ports.find((p) => p.name === planned.port);
    return (
      <aside className="side">
        <Header kind={planned.kind} title={planned.name} sub={<span style={{ color: "var(--w5)" }}>Planned · not applied</span>} onClose={onClose} />
        <div className="kv">
          <span>Port</span><span className="tx mono">{planned.port ?? "—"}</span>
          <span>PoE</span><span className="tx">{port?.poe ?? "—"}</span>
          <span>Note</span><span className="tx">{planned.note ?? "—"}</span>
        </div>
        <Related data={data} id={id} onFinding={onFinding} extra={analysis.findings.filter((f) => f.id.includes(planned.id) || f.id === "wifi-5-one-block" || f.id === "wifi-ft-off")} />
      </aside>
    );
  }

  const d = model.devices.find((x) => x.id === id);
  if (!d) return null;
  const parent = d.parent ? model.devices.find((x) => x.id === d.parent) : undefined;
  const kids = model.devices.filter((x) => x.parent === d.id);
  const wifiKids = kids.filter((x) => x.via?.kind === "wifi");
  const port = d.via?.kind === "port" && d.parent === model.routerId ? model.ports.find((p) => p.name === d.via?.port) : undefined;
  const radios = model.radios.filter((r) => r.apId === d.id);
  const net = model.networks.find((n) => n.id === d.network);

  return (
    <aside className="side">
      <Header
        kind={d.kind}
        title={d.name}
        sub={
          <>
            {KIND_LABEL[d.kind as DeviceKind] ?? d.kind}
            {d.kindCertainty === "inferred" && d.kind !== "unknown" ? <span className="cert">probably</span> : null}
            {d.room ? ` · ${d.room}` : ""} ·{" "}
            <span style={{ color: d.status === "online" ? "var(--ok)" : d.status === "offline" ? "var(--tx-3)" : "var(--tx-2)" }}>{d.status}</span>
          </>
        }
        onClose={onClose}
      />

      {d.via?.kind === "wifi" ? (
        <div className="stats">
          <div><small>Signal</small><b className="mono">{d.via.signal ?? "?"}<span className="faint" style={{ fontSize: 11 }}> dBm</span></b></div>
          <div><small>Band</small><b style={{ color: bandColor(d.via.band) }}>{d.via.band} GHz</b></div>
          <div><small>Rate</small><b className="mono">{d.via.txRate?.replace("Mbps", "") ?? "?"}<span className="faint" style={{ fontSize: 11 }}> Mb/s</span></b></div>
        </div>
      ) : d.kind === "ap" ? (
        <div className="stats">
          <div><small>Clients</small><b className="mono">{wifiKids.length}</b></div>
          <div><small>Radios</small><b className="mono">{radios.length}</b></div>
          <div><small>RouterOS</small><b className="mono">{d.version ?? "?"}</b></div>
        </div>
      ) : d.kind === "router" ? (
        <div className="stats">
          <div><small>Ports used</small><b className="mono">{model.ports.filter((p) => p.deviceIds.length).length}/{model.ports.length}</b></div>
          <div><small>Clients</small><b className="mono">{model.devices.filter((x) => x.zone === "lan" && x.mac && x.status === "online").length}</b></div>
          <div><small>RouterOS</small><b className="mono">{d.version ?? "?"}</b></div>
        </div>
      ) : null}

      <div>
        <div className="sec-title" style={{ marginTop: 0 }}>Details</div>
        <div className="kv">
          {d.ip && <><span>Address</span><span className="tx mono">{d.ip}{d.reserved ? <span className="faint"> reserved</span> : null}</span></>}
          {d.mac && <><span>MAC</span><span className="tx mono">{d.mac}{d.privateMac ? <span className="cert">private</span> : null}</span></>}
          {d.hostname && <><span>Hostname</span><span className="tx mono">{d.hostname}</span></>}
          {d.vendor && <><span>Vendor</span><span className="tx">{d.vendor}</span></>}
          {d.model && <><span>Model</span><span className="tx">{d.model}</span></>}
          {d.version && <><span>RouterOS</span><span className="tx mono">{d.version}</span></>}
          {net && <><span>Network</span><span className="tx">{net.label}{net.cidr ? <span className="faint mono"> {net.cidr}</span> : null}</span></>}
          {parent && (
            <>
              <span>Connected to</span>
              <span className="tx">
                <a href="#" onClick={(e) => { e.preventDefault(); onSelect(parent.id); }} style={{ textDecoration: "none", borderBottom: "1px dotted var(--tx-3)" }}>{parent.name}</a>
                {d.via?.kind === "wifi" ? ` · ${d.via.ssid ?? "Wi-Fi"}` : d.via?.port ? ` · ${d.via.port}` : ""}
                {certLabel(d.via?.certainty) ? <span className="cert">{certLabel(d.via?.certainty)}</span> : null}
              </span>
            </>
          )}
          {port && (
            <>
              <span>Link</span>
              <span className="tx mono">{port.speedMbps ? `${port.speedMbps >= 1000 ? port.speedMbps / 1000 + " Gbps" : port.speedMbps + " Mbps"}` : port.running === false ? "no link" : "?"}{port.poeWatts ? ` · PoE ${port.poeVolts} V ${port.poeWatts} W` : ""}</span>
            </>
          )}
          {d.via?.kind === "wifi" && d.via.rxRate && <><span>Rates</span><span className="tx mono">tx {d.via.txRate} · rx {d.via.rxRate}</span></>}
          {d.only24 && d.via?.band === "2.4" && <><span>Radio</span><span className="tx">2.4 GHz only (by design)</span></>}
        </div>
      </div>

      {radios.length > 0 && (
        <div>
          <div className="sec-title" style={{ marginTop: 0 }}>Radios</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {radios.map((r) => (
              <div key={r.id} className="card" style={{ padding: "10px 11px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
                  <span>{r.band} GHz</span>
                  <span className={`chip band-${r.band} mono`}>ch {r.current?.channel ?? "?"}</span>
                </div>
                <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{r.current ? `${r.current.width} MHz${r.band === "5" ? (r.current.dfs ? " · DFS" : " · non-DFS") : ""}` : r.plan?.width} · {r.clients} client{r.clients === 1 ? "" : "s"}</div>
                <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{r.ssids.join(", ")}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {kids.length > 0 && (
        <div>
          <div className="sec-title" style={{ marginTop: 0 }}>Connected <em className="faint">{kids.length}</em></div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {kids.map((k) => (
              <button key={k.id} onClick={() => onSelect(k.id)} style={{ display: "grid", gridTemplateColumns: "22px 1fr auto auto", gap: 9, alignItems: "center", padding: "7px 2px", border: 0, borderTop: "1px solid var(--hair)", background: "none", textAlign: "left", cursor: "pointer", color: "var(--tx-2)" }}>
                <span style={{ color: "var(--tx-2)" }}><Glyph kind={k.kind} /></span>
                <span style={{ color: "var(--tx-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.name} <span className="faint">{k.via?.ssid ?? k.via?.port ?? ""}</span></span>
                {k.via?.band ? <span className={`chip band-${k.via.band} mono`}>{k.via.band}</span> : <span className="chip mono">wired</span>}
                <span className="mono faint" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>{k.via?.signal ?? ""}{k.via?.signal !== undefined && <SignalBars dbm={k.via.signal} />}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Related data={data} id={id} onFinding={onFinding} />

      {d.facts.length > 0 && (
        <div>
          <div className="sec-title" style={{ marginTop: 0 }}>What the router says</div>
          <div style={{ display: "grid", gap: 6 }}>{d.facts.map((f, i) => <div key={i} className="fact">{f}</div>)}</div>
        </div>
      )}
    </aside>
  );
}

function Header({ kind, title, sub, onClose }: { kind: string; title: string; sub: React.ReactNode; onClose: () => void }) {
  return (
    <div className="ih">
      <div className="ic" style={{ color: "var(--tx-1)" }}><Glyph kind={kind} size={24} /></div>
      <div style={{ minWidth: 0 }}>
        <h2>{title}</h2>
        <div className="sub">{sub}</div>
      </div>
      <button className="btn ghost sm x" onClick={onClose} aria-label="Close">✕</button>
    </div>
  );
}

function Related({ data, id, onFinding, extra = [] }: { data: NetworkPayload; id: string; onFinding: (fid: string) => void; extra?: NetworkPayload["analysis"]["findings"] }) {
  const fs = [...data.analysis.findings.filter((f) => f.devices?.includes(id)), ...extra].filter((f, i, a) => a.findIndex((x) => x.id === f.id) === i);
  if (!fs.length) return null;
  return (
    <div>
      <div className="sec-title" style={{ marginTop: 0 }}>Review</div>
      <div style={{ display: "grid", gap: 6 }}>
        {fs.map((f) => (
          <button key={f.id} className="mini-finding" onClick={() => onFinding(f.id)}>
            <span className="d" style={{ background: SEV_VAR[f.severity] }} />
            <span><b>{f.title}</b>{f.summary.length > 120 ? f.summary.slice(0, 118) + "…" : f.summary}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export type { Device };
