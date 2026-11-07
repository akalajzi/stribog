import { useEffect, useMemo, useState } from "react";
import { fetchChangeContext, type NetworkPayload } from "../api.ts";
import { CliBlock } from "../components/FindingCard.tsx";
import { Check, download, Field, Section, Seg } from "../components/Form.tsx";
import { defaultChangeOptions, generateChange, type ChangeContext, type ChangeOptions, type SideChoice, type SideKind, type WifiSecurity } from "../../core/change.ts";

// Small changes to the setup the router has now. Stribog writes the commands for exactly what is
// chosen and a script that takes them back; it never applies either (see core/change.ts).

const WIDTHS: [string, string][] = [
  ["20mhz", "20 MHz (crowded areas)"],
  ["20/40mhz", "up to 40 MHz"],
  ["20/40/80mhz", "up to 80 MHz (recommended)"],
  ["20/40/80/160mhz", "up to 160 MHz"],
];

export function ChangeView({ data }: { data: NetworkPayload }) {
  const [ctx, setCtx] = useState<ChangeContext>();
  const [error, setError] = useState<string>();
  // Read once: the choices start from the setup as it was when the page opened.
  useEffect(() => {
    fetchChangeContext().then(setCtx, (e: Error) => setError(e.message));
  }, []);

  return (
    <div className="scroll">
      <div className="page pv">
        <div className="pv-head">
          <div>
            <h1>Change</h1>
            <p className="lede">
              Small changes to the setup {data.model.site} has now. Stribog writes the commands for exactly what you choose, and a script that takes them back. It never applies them: you review them and paste them into the
              router's terminal.
            </p>
          </div>
        </div>
        {error ? <div className="card" style={{ padding: 16, color: "var(--bad)" }}>Could not read what a change needs: {error}</div> : !ctx ? <div className="pulse muted">Reading the setup…</div> : <Changes ctx={ctx} />}
      </div>
    </div>
  );
}

function Changes({ ctx }: { ctx: ChangeContext }) {
  const [o, setO] = useState<ChangeOptions>(() => defaultChangeOptions(ctx));
  const [tab, setTab] = useState<"change" | "undo">("change");
  const res = useMemo(() => generateChange(ctx, o), [ctx, o]);
  const set = (patch: (d: ChangeOptions) => void) =>
    setO((prev) => {
      const next = structuredClone(prev);
      patch(next);
      return next;
    });
  const m = ctx.wifi?.main;
  const wifiOk = !!ctx.wifi && !ctx.wifiBlocked;
  const file = `stribog-${tab === "undo" ? "undo" : "change"}-${ctx.site.replace(/[^\w.-]+/g, "-").toLowerCase()}.rsc`;

  if (ctx.blocked) return <div className="card" style={{ padding: 16 }}>{ctx.blocked} Changes need it, so there is nothing to choose here yet.</div>;

  return (
    <div className="pv-split setup">
      <div className="pv-form">
        <div className="card pv-sec">
          <div className="pv-sec-h"><b>What Stribog read</b></div>
          <ul className="ch-read">
            {ctx.read.map((r, i) => (
              <li key={i}>
                {r.text}
                {r.inferred && <span className="cert">probably</span>}
              </li>
            ))}
          </ul>
          <p className="pv-hint">The change is written for this setup. If the router changed since, reload first.</p>
        </div>

        <SideSection kind="guest" ctx={ctx} c={o.guest} wifi={wifiOk} onChange={(f) => set((d) => f(d.guest))} />
        <SideSection kind="iot" ctx={ctx} c={o.iot} wifi={wifiOk} onChange={(f) => set((d) => f(d.iot))} />

        {m ? (
          <Section title={`Wi-Fi "${m.ssid}"`} sub="The main network's name, security and 5 GHz channels">
            <Field label="Network name"><input value={o.wifi.ssid} onChange={(e) => set((d) => (d.wifi.ssid = e.target.value))} /></Field>
            <Field label="Security" hint={m.security === "other" ? `Now: ${m.auth.join(", ") || "not set"}. Choose one to change it.` : undefined}>
              <Seg<WifiSecurity>
                value={o.wifi.security}
                options={[["wpa2", "WPA2"], ["wpa2-wpa3", "WPA2 + WPA3"], ["wpa3", "WPA3 only"]]}
                onChange={(v) => set((d) => (d.wifi.security = v))}
              />
            </Field>
            {m.ch5Profiles.length || m.ch5Inline.length ? (
              <>
                <Field label="5 GHz width">
                  <select value={o.wifi.width5} onChange={(e) => set((d) => (d.wifi.width5 = e.target.value))}>
                    {!m.width5 && <option value="">Not set (the radio decides)</option>}
                    {m.width5 && !WIDTHS.some(([v]) => v === m.width5) && <option value={m.width5}>{m.width5}</option>}
                    {WIDTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
                <Check checked={o.wifi.allowDfs} onChange={(v) => set((d) => (d.wifi.allowDfs = v))} label="Allow radar (DFS) channels" hint="More room on 5 GHz; an access point pauses about a minute when radar is detected." />
              </>
            ) : (
              <p className="pv-hint">Its 5 GHz channels are not set on its configurations, so Stribog cannot change them here.</p>
            )}
          </Section>
        ) : (
          <div className="card pv-sec">
            <div className="pv-sec-h"><b>Wi-Fi</b></div>
            <p className="pv-hint">{ctx.wifiBlocked ?? "Stribog could not find the home network's Wi-Fi, so it has nothing to change there."}</p>
          </div>
        )}
      </div>

      <div className="pv-preview">
        {res.changes.length ? (
          <>
            <div className="pv-script">
              <div className="pv-script-h">
                <div className="seg">
                  <button className={tab === "change" ? "on" : undefined} onClick={() => setTab("change")}>Change</button>
                  <button className={tab === "undo" ? "on" : undefined} onClick={() => setTab("undo")}>Undo</button>
                </div>
                <button className="btn sm" onClick={() => download(file, tab === "undo" ? res.undo : res.script)}>Download .rsc</button>
              </div>
              <div className="pv-warnline">{tab === "undo" ? "Takes back exactly the change on the other tab. Keep it until you are happy with the change." : "Review every line before pasting. Keep the undo script at hand."}</div>
              <CliBlock code={tab === "undo" ? res.undo : res.script} />
            </div>
            {res.notes.length > 0 && (
              <div className="card pv-notes">
                <div className="lbl" style={{ marginBottom: 8 }}>Before and after pasting</div>
                <ul>{res.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </div>
            )}
          </>
        ) : (
          <div className="card ch-empty">
            <b>Nothing to change yet</b>
            <span className="muted">Choose something on the left: the commands for it show up here, with a script to undo them.</span>
            {res.notes.length > 0 && <ul>{res.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </div>
        )}
      </div>
    </div>
  );
}

function SideSection({ kind, ctx, c, wifi, onChange }: { kind: SideKind; ctx: ChangeContext; c: SideChoice; wifi: boolean; onChange: (f: (x: SideChoice) => void) => void }) {
  const title = kind === "guest" ? "Guest network" : "IoT network";
  const sub = kind === "guest" ? "Internet only, on its own VLAN" : "Smart plugs, cameras, TVs: kept away from your other devices";
  const e = ctx.existing[kind];
  if (e)
    return (
      <div className="card pv-sec">
        <div className="pv-sec-h">
          <div>
            <b>{title}</b>
            <div className="faint" style={{ fontSize: 12 }}>Already there</div>
          </div>
        </div>
        <p className="pv-hint">
          {e.iface}
          {e.vlan ? `, VLAN ${e.vlan}` : ""}
          {e.cidr ? `, ${e.cidr}` : ""}
          {e.ssids.length ? `, Wi-Fi ${e.ssids.map((s) => `"${s}"`).join(", ")}` : ""}.{e.inferred ? " Recognised by its name." : ""}
        </p>
      </div>
    );
  return (
    <Section title={title} sub={sub} toggle={c.add} onToggle={(v) => onChange((x) => (x.add = v))}>
      <Field label="VLAN id" hint="Must be free on the router; Stribog picked one that is.">
        <input className="mono" type="number" min={2} max={4094} value={c.vlan} onChange={(ev) => onChange((x) => (x.vlan = Number(ev.target.value)))} />
      </Field>
      <Field label="Subnet"><input className="mono" value={c.subnet} onChange={(ev) => onChange((x) => (x.subnet = ev.target.value))} /></Field>
      {wifi ? (
        <Field label="Wi-Fi name" hint="Leave empty for a wired-only network."><input value={c.ssid} onChange={(ev) => onChange((x) => (x.ssid = ev.target.value))} /></Field>
      ) : (
        <p className="pv-hint">Wired only: {ctx.wifiBlocked}</p>
      )}
      {kind === "guest" ? (
        <Check checked={c.isolation} onChange={(v) => onChange((x) => (x.isolation = v))} label="Client isolation" hint="Guests cannot see each other's phones and laptops." />
      ) : (
        <Check checked={c.lanCanReach} onChange={(v) => onChange((x) => (x.lanCanReach = v))} label="The LAN can reach it" hint="So phones can cast, print or open the camera app. IoT devices still cannot reach the LAN." />
      )}
    </Section>
  );
}
