import { useEffect, useState } from "react";
import { useInternet, type Finding, type NetworkPayload, type Severity } from "../api.ts";
import { WHERE_TEXT } from "../../core/internet.ts";
import { CHANGELOG_URL } from "../../core/updates.ts";
import { fmtMinutes } from "../components/InternetHealth.tsx";
import { STATUS_LABEL } from "../../core/analyze.ts";
import { fmtBps } from "../../core/net.ts";
import { SEV_VAR } from "../components/FindingCard.tsx";
import { Review } from "./Review.tsx";

// The first page: is the network working, and does anything need you. Everything else (ideas,
// notes, what is good) is in the review below, folded until asked for.

interface Alert {
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  href: string;
  /** Opens outside Stribog, in a new tab. */
  external?: boolean;
}

/** RouterOS uptime ("1w2d3h4m5s") as its two largest parts: "1 w 2 d". */
function uptime(v?: string): string | undefined {
  const parts = [...(v ?? "").matchAll(/(\d+)([wdhms])/g)].filter((m) => m[1] !== "0");
  return parts.length ? parts.slice(0, 2).map((m) => `${m[1]} ${m[2]}`).join(" ") : undefined;
}

export function Home({ data, focus, onShow }: { data: NetworkPayload; focus?: string; onShow: (f: Finding) => void }) {
  const { model: m, analysis: a, meta } = data;
  // The review is folded; opening one finding (from an alert or the map) unfolds it.
  const [reviewOpen, setReviewOpen] = useState(!!focus);
  useEffect(() => {
    if (focus) setReviewOpen(true);
  }, [focus]);
  const toggleReview = () => {
    // Folding forgets the finding, so following the same link again unfolds it again.
    if (reviewOpen && focus) location.hash = "#/";
    setReviewOpen(!reviewOpen);
  };
  const router = m.devices.find((d) => d.id === m.routerId);
  const wanPort = router ? m.ports.find((p) => p.name === router.via?.port) : undefined;
  const people = m.devices.filter((d) => d.mac && !d.managed && d.zone === "lan");
  const online = people.filter((d) => d.status === "online");
  const wifi = online.filter((d) => d.via?.kind === "wifi");
  const aps = m.devices.filter((d) => d.kind === "ap" && d.managed);
  const apsUp = aps.filter((d) => d.status === "online");
  const live = m.hasState && !m.sampleState;
  // The router's own check of the internet, once a minute (not for exports, which have no state).
  const { data: net } = useInternet(168);
  const netNow = meta.mode === "files" ? undefined : net?.now;

  // Alerts: what is wrong right now, then what the review says is worth fixing.
  const alerts: Alert[] = [];
  if (meta.error) alerts.push({ key: "read", severity: meta.stale ? "warning" : "critical", title: meta.stale ? "The router is not answering" : "Could not read the router", detail: meta.error, href: "#/" });
  if (netNow?.s === "down")
    alerts.push({ key: "net-down", severity: "critical", title: "The internet is down", detail: netNow.w ? WHERE_TEXT[netNow.w].long : undefined, href: "#/network" });
  else if (netNow?.s === "unsteady")
    alerts.push({ key: "net-unsteady", severity: "warning", title: "The internet is losing packets", detail: "It answers, but some packets get lost: calls and games may stutter.", href: "#/network" });
  if (live && !m.wan.address && netNow?.s !== "down") alerts.push({ key: "wan", severity: "critical", title: "The router has no internet address", detail: `Nothing on ${m.wan.iface ?? "the WAN port"}.`, href: "#/network" });
  for (const ap of aps.filter((d) => live && d.status !== "online")) alerts.push({ key: ap.id, severity: "critical", title: `${ap.name} is offline`, detail: "Wi-Fi from this access point is down.", href: `#/map?d=${encodeURIComponent(ap.id)}` });
  // A pause is deliberate, but easy to forget: listed, without changing the status.
  for (const d of m.devices.filter((x) => x.paused))
    alerts.push({ key: `paused-${d.id}`, severity: "info", title: `${d.name}: internet paused`, detail: "It keeps the local network. Resume it on its page.", href: `#/device?d=${encodeURIComponent(d.id)}` });
  // A newer RouterOS, as of the router's last check with MikroTik (Stribog asks it daily).
  const up = m.updates;
  if (up?.available)
    alerts.push({
      key: "routeros-update",
      severity: "info",
      title: `RouterOS ${up.latest} is out`,
      detail: `Runs ${up.installed} (${up.channel}). Updating restarts the router, so read what changed first. Then: System → Packages in WinBox or WebFig.`,
      href: CHANGELOG_URL,
      external: true,
    });
  if (up?.firmware?.behind)
    alerts.push({
      key: "firmware",
      severity: "info",
      title: "The router's firmware is behind its RouterOS",
      detail: `Firmware ${up.firmware.current}, RouterOS brings ${up.firmware.upgrade}. System → RouterBOARD → Upgrade, then restart the router.`,
      href: `#/map?d=${encodeURIComponent(m.routerId ?? "")}`,
    });
  for (const f of a.findings.filter((x) => !x.accepted && (x.severity === "critical" || x.severity === "warning")))
    alerts.push({ key: f.id, severity: f.severity, title: f.title, detail: f.summary, href: `#/?f=${encodeURIComponent(f.id)}` });

  const internetOk = netNow ? netNow.s !== "down" : !live || !!m.wan.address;
  // The last outage over the week, or how long it has been fine, so the tile answers "was it down?" too.
  const lastOutage = net?.episodes.find((e) => e.state === "down" && !e.ongoing);
  const outageLine = !net || meta.mode === "files" || !net.minutes.recorded
    ? undefined
    : lastOutage
      ? `last outage ${new Date(lastOutage.from).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${fmtMinutes(Math.max(1, Math.round((lastOutage.to - lastOutage.from) / 60_000)))}`
      : `no outages in ${fmtMinutes(net.minutes.recorded)} checked`;
  const status = alerts.some((x) => x.severity === "critical") ? "attention" : alerts.some((x) => x.severity !== "info") ? "loose-ends" : "healthy";
  const statusColor = status === "attention" ? "var(--bad)" : status === "loose-ends" ? "var(--warn)" : "var(--ok)";
  const toFix = a.counts.critical + a.counts.warning;
  const rest = [
    toFix && `${toFix} worth fixing`,
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
              {!live && !netNow ? "—" : internetOk ? (netNow?.s === "unsteady" ? "Losing packets" : "Up") : "Down"}
            </b>
            {wanPort?.rxBps !== undefined && <span className="mono">↓ {fmtBps(wanPort.rxBps)} · ↑ {fmtBps(wanPort.txBps ?? 0)}</span>}
            <span className="faint">
              {m.wan.address ?? "no address"}
              {m.wan.doubleNat === true ? " · double NAT" : m.wan.addressKind === "public" ? " · public" : ""}
            </span>
            {outageLine && <span className="faint">{outageLine}</span>}
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
            {up?.available && <span className="faint">RouterOS {up.latest} is out</span>}
          </a>
        </div>

        <div className="sec-title">Needs you {alerts.length ? <em className="faint">{alerts.length}</em> : null}</div>
        {alerts.length ? (
          <div className="card home-alerts">
            {alerts.map((x) => (
              <a key={x.key} href={x.href} className="home-alert" {...(x.external ? { target: "_blank", rel: "noreferrer" } : {})}>
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

        <section className="home-review">
          <button className="sec-title home-review-toggle" aria-expanded={reviewOpen} onClick={toggleReview}>
            <span className="chev" aria-hidden>›</span>
            Review {rest.length ? <em className="faint">{rest.join(" · ")}</em> : null}
          </button>
          {reviewOpen && <Review data={data} focus={focus} onShow={onShow} />}
        </section>
      </div>
    </div>
  );
}
