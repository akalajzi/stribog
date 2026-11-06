import { useState } from "react";
import type { Finding, Severity } from "../api.ts";
import { CATEGORY_LABEL } from "../../core/analyze.ts";

export const SEV_LABEL: Record<Severity, string> = { critical: "Fix now", warning: "Worth fixing", suggestion: "Idea", info: "Note", pass: "Good" };
export const SEV_VAR: Record<Severity, string> = { critical: "var(--bad)", warning: "var(--warn)", suggestion: "var(--idea)", info: "var(--tx-3)", pass: "var(--ok)" };

const WHERE: Record<string, string> = { router: "On the router", ap: "On the access point", isp: "With your ISP", device: "On the device", plan: "Plan" };

export function CliBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <pre className="cli">
        {code.split("\n").map((line, i) => (
          <div key={i} className={line.trim().startsWith("#") ? "c" : undefined}>{line || " "}</div>
        ))}
      </pre>
      <button
        className="btn sm"
        style={{ position: "absolute", top: 8, right: 8 }}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function FindingCard({ f, open: openProp, onShow, deviceName }: { f: Finding; open?: boolean; onShow?: (f: Finding) => void; deviceName?: (id: string) => string }) {
  const [open, setOpen] = useState(!!openProp);
  const expandable = !!(f.detail?.length || f.evidence?.length || f.fix);
  return (
    <div className={`finding${open ? " open" : ""}`} id={`f-${f.id}`}>
      <button className="head" onClick={() => expandable && setOpen(!open)} style={{ cursor: expandable ? "pointer" : "default" }}>
        <span className="ind" style={{ background: SEV_VAR[f.severity], boxShadow: f.severity === "info" ? "none" : `0 0 0 3px color-mix(in srgb, ${SEV_VAR[f.severity]} 18%, transparent)` }} />
        <span>
          <h4>{f.title}</h4>
          <p>{f.summary}</p>
        </span>
        <span className="meta">
          <span className="chip">{CATEGORY_LABEL[f.category]}</span>
          {expandable && <span style={{ transform: open ? "rotate(90deg)" : "none", transition: ".15s", display: "inline-block" }}>›</span>}
        </span>
      </button>
      {open && expandable && (
        <div className="body">
          {f.detail?.map((p, i) => <p key={i}>{p}</p>)}
          {f.evidence?.length ? (
            <div className="ev">
              <div className="lbl" style={{ borderLeft: 0, paddingLeft: 0, fontFamily: "var(--sans)" }}>Seen on the router</div>
              {f.evidence.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          ) : null}
          {f.fix && (
            <div className="fix">
              <div className="lbl">How to fix · {WHERE[f.fix.where]}</div>
              {f.fix.steps?.length ? <ol>{f.fix.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
              {f.fix.cli && <CliBlock code={f.fix.cli} />}
              {f.fix.caution && <div className="caution">⚠ {f.fix.caution}</div>}
              {f.fix.cli && <div className="faint" style={{ fontSize: 12 }}>Stribog never applies changes. Review the script, then paste it into the router terminal.</div>}
            </div>
          )}
          {onShow && f.devices?.length ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn sm" onClick={() => onShow(f)}>Show on map</button>
              {deviceName && <span className="faint" style={{ alignSelf: "center", fontSize: 12 }}>{f.devices.map(deviceName).join(", ")}</span>}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
