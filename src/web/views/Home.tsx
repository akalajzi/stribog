import type { NetworkPayload, Severity } from "../api.ts";
import { STATUS_LABEL } from "../../core/analyze.ts";
import { fmtBps } from "../../core/net.ts";
import { SEV_VAR } from "../components/FindingCard.tsx";

// The first page: is the network working, and does anything need you. Everything else (ideas,
// notes, what is good) is on the review page.

interface Alert {
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  href: string;
}

/** RouterOS uptime ("1w2d3h4m5s") as its two largest parts: "1 w 2 d". */
function uptime(v?: string): string | undefined {
  const parts = [...(v ?? "").matchAll(/(\d+)([wdhms])/g)].filter((m) => m[1] !== "0");
  return parts.length ? parts.slice(0, 2).map((m) => `${m[1]} ${m[2]}`).join(" ") : undefined;
}

export function Home({ data }: { data: NetworkPayload }) {
  const { model: m, analysis: a, meta } = data;
  const router = m.devices.find((d) => d.id === m.routerId);
  const wanPort = router ? m.ports.find((p) => p.name === router.via?.port) : undefined;
  const people = m.devices.filter((d) => d.mac && !d.managed && d.zone === "lan");
  const online = people.filter((d) => d.status === "online");
  const wifi = online.filter((d) => d.via?.kind === "wifi");
  const aps = m.devices.filter((d) => d.kind === "ap" && d.managed);
  const apsUp = aps.filter((d) => d.status === "online");
  const live = m.hasState && !m.sampleState;

  // Alerts: what is wrong right now, then what the review says is worth fixing.
  const alerts: Alert[] = [];
  if (meta.error) alerts.push({ key: "read", severity: meta.stale ? "warning" : "critical", title: meta.stale ? "The router is not answering" : "Could not read the router", detail: meta.error, href: "#/" });
  if (live && !m.wan.address) alerts.push({ key: "wan", severity: "critical", title: "The router has no internet address", detail: `Nothing on ${m.wan.iface ?? "the WAN port"}.`, href: "#/network" });
  for (const ap of aps.filter((d) => live && d.status !== "online")) alerts.push({ key: ap.id, severity: "critical", title: `${ap.name} is offline`, detail: "Wi-Fi from this access point is down.", href: `#/map?d=${encodeURIComponent(ap.id)}` });
  for (const f of a.findings.filter((x) => !x.accepted && (x.severity === "critical" || x.severity === "warning")))
    alerts.push({ key: f.id, severity: f.severity, title: f.title, detail: f.summary, href: `#/review?f=${encodeURIComponent(f.id)}` });

  const internetOk = !live || !!m.wan.address;
  const status = alerts.some((x) => x.severity === "critical") ? "attention" : alerts.length ? "loose-ends" : "healthy";
  const statusColor = status === "attention" ? "var(--bad)" : status === "loose-ends" ? "var(--warn)" : "var(--ok)";
  const rest = [
    a.counts.suggestion && `${a.counts.suggestion} idea${a.counts.suggestion === 1 ? "" : "s"}`,
    a.counts.info && `${a.counts.info} note${a.counts.info === 1 ? "" : "s"}`,
    a.counts.pass && `${a.counts.pass} good`,
    a.accepted && `${a.accepted} accepted`,
  ].filter(Boolean);

  return (
    <div className="scroll">
      <div className="page home">
        <header className="home-head">
          <h1>{m.site}</h1>
          <span className="home-status">
            <span className="dot" style={{ background: statusColor, boxShadow: `0 0 0 4px color-mix(in srgb, ${statusColor} 18%, transparent)` }} />
            {STATUS_LABEL[status]}
          </span>
        </header>

        <div className="home-tiles">
          <a className="card home-tile" href="#/network">
            <small>Internet</small>
            <b>
              <span className="dot" style={{ background: internetOk ? "var(--ok)" : "var(--bad)", boxShadow: "none" }} />
              {!live ? "—" : internetOk ? "Up" : "Down"}
            </b>
            {wanPort?.rxBps !== undefined && <span className="mono">↓ {fmtBps(wanPort.rxBps)} · ↑ {fmtBps(wanPort.txBps ?? 0)}</span>}
            <span className="faint">
              {m.wan.address ?? "no address"}
              {m.wan.doubleNat === true ? " · double NAT" : m.wan.addressKind === "public" ? " · public" : ""}
            </span>
          </a>
          <a className="card home-tile" href="#/clients">
            <small>Devices</small>
            <b className="mono">{live ? online.length : "—"}</b>
            <span>online{live ? ` · ${wifi.length} Wi-Fi, ${online.length - wifi.length} wired` : ""}</span>
            <span className="faint">{people.length} known</span>
          </a>
          <a className="card home-tile" href="#/wifi">
            <small>Wi-Fi</small>
            <b className="mono">{aps.length ? `${apsUp.length}/${aps.length}` : m.ssids.length ? "on" : "—"}</b>
            <span>{aps.length ? `access point${aps.length === 1 ? "" : "s"} up` : "on the router"}</span>
            <span className="faint">{m.ssids.map((s) => s.name).join(", ") || "no networks"}</span>
          </a>
          <a className="card home-tile" href={`#/map?d=${encodeURIComponent(m.routerId ?? "")}`}>
            <small>Router</small>
            <b className="mono">{m.system?.cpuLoad !== undefined ? `${m.system.cpuLoad}%` : "—"}</b>
            <span>
              CPU{m.system?.memoryUsed !== undefined ? ` · memory ${m.system.memoryUsed}%` : ""}
            </span>
            <span className="faint">{[uptime(m.system?.uptime) && `up ${uptime(m.system?.uptime)}`, router?.version && `RouterOS ${router.version}`].filter(Boolean).join(" · ")}</span>
          </a>
        </div>

        <div className="sec-title">Needs you {alerts.length ? <em className="faint">{alerts.length}</em> : null}</div>
        {alerts.length ? (
          <div className="card home-alerts">
            {alerts.map((x) => (
              <a key={x.key} href={x.href} className="home-alert">
                <span className="dot" style={{ background: SEV_VAR[x.severity], boxShadow: "none" }} />
                <span>
                  <b>{x.title}</b>
                  {x.detail && <span className="faint">{x.detail}</span>}
                </span>
                <span className="faint">›</span>
              </a>
            ))}
          </div>
        ) : (
          <div className="card home-quiet">Nothing needs you right now.</div>
        )}

        {rest.length > 0 && (
          <a className="home-more" href="#/review">
            Review: {rest.join(" · ")} ›
          </a>
        )}
      </div>
    </div>
  );
}
