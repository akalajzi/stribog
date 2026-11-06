import { useMemo, useState } from "react";
import type { Category, Finding, NetworkPayload, Severity } from "../api.ts";
import { CATEGORY_LABEL, isOpen } from "../../core/analyze.ts";
import { FindingCard, SEV_LABEL, SEV_VAR } from "../components/FindingCard.tsx";

const ORDER: Severity[] = ["critical", "warning", "suggestion", "info", "pass"];

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  const color = score >= 85 ? "var(--ok)" : score >= 65 ? "var(--g1)" : score >= 40 ? "var(--warn)" : "var(--bad)";
  return (
    <div style={{ position: "relative", width: 180, height: 180 }}>
      <svg width={180} height={180} viewBox="0 0 180 180">
        <circle cx={90} cy={90} r={r} fill="none" stroke="var(--fg)" strokeOpacity={.06} strokeWidth={10} />
        <circle cx={90} cy={90} r={r} fill="none" stroke={color} strokeWidth={10} strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 90 90)" style={{ filter: `drop-shadow(0 0 8px ${color})`, transition: "stroke-dasharray .8s" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div className="num" style={{ fontSize: 46, fontWeight: 600, letterSpacing: "-.04em", lineHeight: 1 }}>{score}</div>
          <div className="muted" style={{ marginTop: 6, textTransform: "capitalize" }}>{grade === "poor" ? "needs attention" : grade}</div>
        </div>
      </div>
    </div>
  );
}

export function Overview({ data, onShow }: { data: NetworkPayload; onShow: (f: Finding) => void }) {
  const { model, analysis } = data;
  const [sev, setSev] = useState<Severity | "open" | "accepted">("open");
  const [cat, setCat] = useState<Category | "all">("all");
  const name = (id: string) => model.devices.find((d) => d.id === id)?.name ?? id;

  const visible = useMemo(
    () =>
      analysis.findings.filter((f) => (sev === "open" ? isOpen(f) : sev === "accepted" ? !!f.accepted : f.severity === sev && !f.accepted) && (cat === "all" || f.category === cat)),
    [analysis, sev, cat],
  );
  const cats = [...new Set(analysis.findings.map((f) => f.category))];

  const lan = model.networks.find((n) => n.role === "lan");
  const online = model.devices.filter((d) => d.mac && d.status === "online" && d.zone === "lan");
  const wifi = online.filter((d) => d.via?.kind === "wifi");
  const aps = model.devices.filter((d) => d.kind === "ap");
  const top = analysis.findings.filter((f) => !f.accepted && (f.severity === "critical" || f.severity === "warning"));

  return (
    <div className="scroll">
      <div className="page">
        <h1>{model.site}</h1>
        <p className="lede">
          A review of how this network is set up: what is solid, what is fragile, and exactly what to change. Built from{" "}
          {model.sources.map((s) => s.label.split("/").pop()).join(", ")}
          {data.meta.sample ? ", with sample runtime data until a live router connection is configured" : ""}.
        </p>

        <div className="hero">
          <div className="card score">
            <ScoreRing score={analysis.score} grade={analysis.grade} />
            <div style={{ display: "flex", gap: 14, marginTop: 14, fontSize: 12 }}>
              {(["warning", "suggestion", "pass"] as Severity[]).map((s) => (
                <span key={s} className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <span className="dot" style={{ background: SEV_VAR[s], boxShadow: "none" }} />
                  <b className="mono" style={{ color: "var(--tx-1)", fontWeight: 500 }}>{analysis.counts[s]}</b> {s === "pass" ? "good" : s === "warning" ? "to fix" : "ideas"}
                </span>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <div className="tiles">
              <div className="card tile"><small>Online</small><b className="mono">{online.length}</b><span>{wifi.length} on Wi-Fi · {online.length - wifi.length} wired</span></div>
              <div className="card tile"><small>Wi-Fi</small><b className="mono">{model.ssids.length}</b><span>{model.ssids.map((s) => s.name).join(", ") || "no SSIDs"} · {aps.length} AP{aps.length === 1 ? "" : "s"}</span></div>
              <div className="card tile"><small>Home LAN</small><b className="mono" style={{ fontSize: 18, paddingTop: 4 }}>{lan?.cidr ?? "—"}</b><span>{lan?.dhcp ? `${lan.dhcp.used ?? "?"} of ${lan.dhcp.size} pool addresses used` : "no DHCP"}</span></div>
              <div className="card tile"><small>Internet</small><b style={{ fontSize: 18, paddingTop: 4 }}>{model.wan.doubleNat === true ? "Double NAT" : model.wan.addressKind === "public" ? "Public IP" : "Unknown"}</b><span>{model.wan.type.toUpperCase()} on {model.wan.iface ?? "?"}{model.wan.address ? ` · ${model.wan.address}` : ""}</span></div>
            </div>
            <div className="card" style={{ padding: "14px 16px" }}>
              <div className="lbl" style={{ marginBottom: 8 }}>Most important</div>
              <div style={{ display: "grid", gap: 6 }}>
                {top.slice(0, 4).map((f) => (
                  <a key={f.id} href={`#f-${f.id}`} onClick={(e) => { e.preventDefault(); setSev("open"); setCat("all"); document.getElementById(`f-${f.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }} style={{ display: "flex", gap: 10, alignItems: "baseline", textDecoration: "none" }}>
                    <span className="dot" style={{ background: SEV_VAR[f.severity], boxShadow: "none", transform: "translateY(-1px)" }} />
                    <span>{f.title}</span>
                  </a>
                ))}
                {!top.length && <span className="muted">Nothing urgent. Have a look at the ideas below.</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="sec-title">Review <em className="faint">{visible.length} shown</em></div>
        <div className="filters" style={{ marginBottom: 14 }}>
          <button className={`fchip${sev === "open" ? " on" : ""}`} onClick={() => setSev("open")}>Everything to look at <span className="n">{analysis.findings.filter(isOpen).length}</span></button>
          {ORDER.map((s) =>
            analysis.counts[s] ? (
              <button key={s} className={`fchip${sev === s ? " on" : ""}`} onClick={() => setSev(s)}>
                <span className="dot" style={{ background: SEV_VAR[s], boxShadow: "none" }} />
                {SEV_LABEL[s]} <span className="n">{analysis.counts[s]}</span>
              </button>
            ) : null,
          )}
          {analysis.accepted > 0 && (
            <button className={`fchip${sev === "accepted" ? " on" : ""}`} onClick={() => setSev("accepted")} title="Findings you accepted as fine here. They do not count in the score until they change.">
              Accepted <span className="n">{analysis.accepted}</span>
            </button>
          )}
          <span style={{ width: 1, height: 18, background: "var(--hair-2)", margin: "0 4px" }} />
          <button className={`fchip${cat === "all" ? " on" : ""}`} onClick={() => setCat("all")}>All areas</button>
          {cats.map((c) => (
            <button key={c} className={`fchip${cat === c ? " on" : ""}`} onClick={() => setCat(c)}>{CATEGORY_LABEL[c]}</button>
          ))}
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {visible.map((f) => <FindingCard key={f.id} f={f} onShow={onShow} deviceName={name} />)}
        </div>
      </div>
    </div>
  );
}
