import { useState } from "react";
import { fetchFixRequest, type Finding, type Severity } from "../api.ts";
import { CATEGORY_LABEL } from "../../core/analyze.ts";

export const SEV_LABEL: Record<Severity, string> = { critical: "Fix now", warning: "Worth fixing", suggestion: "Idea", info: "Note", pass: "Good" };
export const SEV_VAR: Record<Severity, string> = { critical: "var(--bad)", warning: "var(--warn)", suggestion: "var(--idea)", info: "var(--tx-3)", pass: "var(--ok)" };

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
  const expandable = f.severity !== "pass" || !!(f.detail?.length || f.evidence?.length);
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
          {f.severity !== "pass" && <AskAgent id={f.id} />}
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

/**
 * Fixes come from an agent, not from Stribog: it hands over the finding with the configuration
 * involved, and the agent works out what to change on this network.
 */
function AskAgent({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | string>("idle");
  const copy = async () => {
    setState("busy");
    try {
      await navigator.clipboard.writeText(await fetchFixRequest(id));
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setState((e as Error).message);
    }
  };
  return (
    <div className="ask">
      <div className="lbl">How to fix it</div>
      <p>
        Stribog only finds problems; the right fix depends on the rest of your network. Ask an AI agent: the request gives it this finding, the configuration involved and your notes, and asks for options, exact
        commands, how to check and how to undo.
      </p>
      <div className="ask-row">
        <button className="btn sm" onClick={() => void copy()} disabled={state === "busy"}>
          {state === "copied" ? "Copied" : state === "busy" ? "Copying…" : "Copy request for an agent"}
        </button>
        <span className="faint">
          or, in an agent connected to Stribog (Settings → Agents), use the prompt <span className="mono">fix_finding</span> with <span className="mono">{id}</span>
        </span>
      </div>
      {state !== "idle" && state !== "busy" && state !== "copied" && <p className="st-error">{state}</p>}
      <p className="faint">Check what the agent suggests before you change anything. Stribog never applies changes.</p>
    </div>
  );
}
