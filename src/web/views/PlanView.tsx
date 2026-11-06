import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { NetworkPayload } from "../api.ts";
import { CliBlock } from "../components/FindingCard.tsx";
import { defaultSetupOptions, generateSetup, type SetupOptions, type SetupPreset, type SideNetwork } from "../../core/setup.ts";
import "./plan.css";

// A clean, opinionated setup to start over with. Stribog only writes text; nothing is ever applied.
// Fixes for what the review finds come from an agent (see core/advice.ts), not from here.

const today = () => new Date().toISOString().slice(0, 10);

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PlanView({ data }: { data: NetworkPayload }) {
  return (
    <div className="scroll">
      <div className="page pv">
        <div className="pv-head">
          <div>
            <h1>New setup</h1>
            <p className="lede">A clean, opinionated MikroTik setup for a router reset with no default configuration. Choose the options; the script updates as you go.</p>
          </div>
        </div>
        <NewSetup data={data} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New setup

function initialOptions(data: NetworkPayload, preset: SetupPreset): SetupOptions {
  const { model } = data;
  const ports = model.ports.map((p) => p.defaultName);
  const o = defaultSetupOptions(preset, ports.length ? ports : undefined);
  // Start from this router's hardware: same ISP port, access points where they are today.
  const up = model.ports.find((p) => p.deviceIds.includes("upstream"));
  if (up) o.wan.port = up.defaultName;
  const apIds = new Set(model.devices.filter((d) => d.kind === "ap").map((d) => d.id));
  o.apPorts = model.ports.filter((p) => p.deviceIds.some((id) => apIds.has(id)) || (p.planned && model.planned.find((x) => x.id === p.planned)?.kind === "ap")).map((p) => p.defaultName).filter((p) => p !== o.wan.port);
  const country = model.ssids.find((s) => s.country)?.country;
  if (country) o.wifi.country = country;
  if (model.timezone && model.timezone !== "manual") o.timezone = model.timezone;
  if (model.wan.type === "pppoe") o.wan.type = "pppoe";
  return o;
}

function NewSetup({ data }: { data: NetworkPayload }) {
  const [o, setO] = useState<SetupOptions>(() => initialOptions(data, "home"));
  const res = useMemo(() => generateSetup(o), [o]);
  const set = (patch: (d: SetupOptions) => void) =>
    setO((prev) => {
      const next = structuredClone(prev);
      patch(next);
      return next;
    });
  const sideLabel = o.preset === "office" ? "Devices" : "IoT";
  const lanPorts = o.ports.filter((p) => p !== o.wan.port);

  return (
    <div className="pv-split setup">
      <div className="pv-form">
        <Section title="Preset">
          <div className="seg">
            {(["home", "office"] as SetupPreset[]).map((p) => (
              <button key={p} className={o.preset === p ? "on" : undefined} onClick={() => setO(initialOptions(data, p))}>{p === "home" ? "Home" : "Small office"}</button>
            ))}
          </div>
          <p className="pv-hint">{o.preset === "home" ? "One trusted network; add guest and IoT networks if you want them." : "Guest Wi-Fi on, plus a separate network for printers, cameras and other shared devices."}</p>
        </Section>

        <Section title="Router">
          <Field label="Name"><input value={o.identity} onChange={(e) => set((d) => (d.identity = e.target.value))} /></Field>
          <Field label="Time zone"><input value={o.timezone} onChange={(e) => set((d) => (d.timezone = e.target.value))} placeholder="Region/City, e.g. America/Chicago" /></Field>
        </Section>

        <Section title="Internet">
          <Field label="WAN port">
            <select value={o.wan.port} onChange={(e) => set((d) => { d.wan.port = e.target.value; d.apPorts = d.apPorts.filter((p) => p !== e.target.value); })}>
              {o.ports.map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Connection">
            <Seg value={o.wan.type} options={[["dhcp", "DHCP"], ["pppoe", "PPPoE"]]} onChange={(v) => set((d) => (d.wan.type = v))} />
          </Field>
          {o.wan.type === "pppoe" && (
            <Field label="PPPoE user" hint="The password is never part of the script; you set it on the router.">
              <input value={o.wan.pppoeUser ?? ""} onChange={(e) => set((d) => (d.wan.pppoeUser = e.target.value))} placeholder="user@isp" />
            </Field>
          )}
          <p className="pv-hint">DHCP when the ISP router or ONT hands out the address (bridge mode or double NAT); PPPoE when the ISP gave you a username.</p>
        </Section>

        <Section title="Home network">
          <Field label="Subnet"><input className="mono" value={o.lan.subnet} onChange={(e) => set((d) => (d.lan.subnet = e.target.value))} /></Field>
          <Field label="DHCP pool" hint="Keep fixed addresses outside this range."><input className="mono" value={o.lan.pool} onChange={(e) => set((d) => (d.lan.pool = e.target.value))} /></Field>
          <Field label="Lease time">
            <select value={o.lan.leaseTime} onChange={(e) => set((d) => (d.lan.leaseTime = e.target.value))}>
              {[["1h", "1 hour"], ["8h", "8 hours"], ["1d", "1 day"], ["3d", "3 days"], ["1w", "1 week"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </Section>

        <Section title="DNS">
          <Seg value={o.dns.mode} options={[["router", "Router answers"], ["lan-server", "LAN server first"]]} onChange={(v) => set((d) => (d.dns.mode = v))} />
          <Field label="Upstreams" hint="Where the router itself asks. Comma-separated.">
            <input className="mono" value={o.dns.upstreams.join(", ")} onChange={(e) => set((d) => (d.dns.upstreams = e.target.value.split(/[,\s]+/).filter(Boolean)))} />
          </Field>
          {o.dns.mode === "lan-server" && (
            <Field label="LAN server" hint="For example a Pi-hole or AdGuard box; the router is handed out as fallback.">
              <input className="mono" value={o.dns.lanServer ?? ""} onChange={(e) => set((d) => (d.dns.lanServer = e.target.value))} placeholder="192.168.88.10" />
            </Field>
          )}
        </Section>

        <Section title="Wi-Fi" toggle={o.wifi.enabled} onToggle={(v) => set((d) => (d.wifi.enabled = v))} sub="CAPsMAN: the router manages every MikroTik access point">
          <Field label="Network name"><input value={o.wifi.ssid} onChange={(e) => set((d) => (d.wifi.ssid = e.target.value))} /></Field>
          <Field label="Security"><Seg value={o.wifi.security} options={[["wpa2-wpa3", "WPA2 + WPA3"], ["wpa3", "WPA3 only"]]} onChange={(v) => set((d) => (d.wifi.security = v))} /></Field>
          <Field label="Country"><input value={o.wifi.country} onChange={(e) => set((d) => (d.wifi.country = e.target.value))} /></Field>
          <Field label="Access points"><Seg value={o.wifi.gen} options={[["ax", "Wi-Fi 6 (ax)"], ["ac", "Wi-Fi 5 (ac)"]]} onChange={(v) => set((d) => (d.wifi.gen = v))} /></Field>
          <Field label="2.4 GHz"><span className="pv-fixed">Channels 1, 6, 11 at 20 MHz</span></Field>
          <Field label="5 GHz width">
            <select value={o.wifi.width5} onChange={(e) => set((d) => (d.wifi.width5 = e.target.value as SetupOptions["wifi"]["width5"]))}>
              <option value="20mhz">20 MHz (crowded areas)</option>
              <option value="20/40mhz">up to 40 MHz</option>
              <option value="20/40/80mhz">up to 80 MHz (recommended)</option>
              <option value="20/40/80/160mhz">up to 160 MHz</option>
            </select>
          </Field>
          <Check checked={o.wifi.allowDfs} onChange={(v) => set((d) => (d.wifi.allowDfs = v))} label="Allow radar (DFS) channels" hint="More room on 5 GHz; an AP pauses about a minute when radar is detected." />
        </Section>

        <Section title="Guest network" toggle={o.guest.enabled} onToggle={(v) => set((d) => (d.guest.enabled = v))} sub="Internet only, on its own VLAN">
          <SideFields s={o.guest} wifi={o.wifi.enabled} onChange={(f) => set((d) => f(d.guest))} />
          <Check checked={o.guest.isolation} onChange={(v) => set((d) => (d.guest.isolation = v))} label="Client isolation" hint="Guests cannot see each other's phones and laptops." />
        </Section>

        <Section title={`${sideLabel} network`} toggle={o.iot.enabled} onToggle={(v) => set((d) => (d.iot.enabled = v))} sub={o.preset === "office" ? "Printers, cameras and shared devices" : "Smart plugs, cameras, TVs; WPA2 for compatibility"}>
          <SideFields s={o.iot} wifi={o.wifi.enabled} onChange={(f) => set((d) => f(d.iot))} />
          <Check checked={o.iot.lanCanReach} onChange={(v) => set((d) => (d.iot.lanCanReach = v))} label="The LAN can reach it" hint={`So phones can cast, print or open the camera app. ${sideLabel} devices still cannot reach the LAN.`} />
        </Section>

        {(o.guest.enabled || o.iot.enabled) && lanPorts.length > 0 && (
          <Section title="Access point ports" sub="Ports that carry the extra VLANs; none ticked means all LAN ports">
            <div className="pv-ports">
              {lanPorts.map((p) => (
                <label key={p} className={`pv-port${o.apPorts.includes(p) ? " on" : ""}`}>
                  <input type="checkbox" checked={o.apPorts.includes(p)} onChange={() => set((d) => (d.apPorts = d.apPorts.includes(p) ? d.apPorts.filter((x) => x !== p) : [...d.apPorts, p]))} />
                  <span className="mono">{p.replace(/^ether/, "")}</span>
                </label>
              ))}
            </div>
          </Section>
        )}

        <Section title="Management & upkeep">
          <Field label="Admin from" hint="WebFig, SSH and WinBox only answer from here. Telnet, FTP and API are switched off.">
            <input className="mono" value={o.adminSubnet ?? ""} placeholder={o.lan.subnet} onChange={(e) => set((d) => (d.adminSubnet = e.target.value || undefined))} />
          </Field>
          <Field label="Time servers"><input className="mono" value={o.ntp.join(", ")} onChange={(e) => set((d) => (d.ntp = e.target.value.split(/[,\s]+/).filter(Boolean)))} /></Field>
          <Check checked={o.nightlyExport} onChange={(v) => set((d) => (d.nightlyExport = v))} label="Nightly configuration export" hint="Saved on the router at 03:30, without secrets." />
        </Section>
      </div>

      <div className="pv-preview">
        <div className="pv-script">
          <div className="pv-script-h">
            <div>
              <b>Setup script</b>
              <span className="faint"> · RouterOS v7.15+ · <span className="mono">{res.script.split("\n").length}</span> lines</span>
            </div>
            <button className="btn sm" onClick={() => download(`stribog-setup-${o.identity.replace(/[^\w.-]+/g, "-") || "router"}.rsc`, res.script)}>Download .rsc</button>
          </div>
          <div className="pv-warnline">For a router reset with no default configuration. Pasting it on top of a working setup will clash.</div>
          <CliBlock code={res.script} />
        </div>
        {res.notes.length > 0 && (
          <div className="card pv-notes">
            <div className="lbl" style={{ marginBottom: 8 }}>Before and after pasting</div>
            <ul>{res.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, sub, toggle, onToggle, children }: { title: string; sub?: string; toggle?: boolean; onToggle?: (v: boolean) => void; children: ReactNode }) {
  const off = toggle === false;
  return (
    <div className={`card pv-sec${off ? " off" : ""}`}>
      <div className="pv-sec-h">
        <div>
          <b>{title}</b>
          {sub && <div className="faint" style={{ fontSize: 12 }}>{sub}</div>}
        </div>
        {onToggle && (
          <button className={`pv-switch${toggle ? " on" : ""}`} role="switch" aria-checked={!!toggle} aria-label={title} onClick={() => onToggle(!toggle)}><i /></button>
        )}
      </div>
      {!off && <div className="pv-sec-b">{children}</div>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="pv-field">
      <span className="l">{label}</span>
      <span className="c">
        {children}
        {hint && <span className="pv-hint">{hint}</span>}
      </span>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => <button key={v} type="button" className={value === v ? "on" : undefined} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="pv-checkline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="box" />
      <span>
        {label}
        {hint && <span className="pv-hint">{hint}</span>}
      </span>
    </label>
  );
}

function SideFields({ s, wifi, onChange }: { s: SetupOptions["guest"] | SetupOptions["iot"]; wifi: boolean; onChange: (f: (x: SideNetwork) => void) => void }) {
  return (
    <>
      <Field label="VLAN id"><input className="mono" type="number" min={2} max={4094} value={s.vlan} onChange={(e) => onChange((x) => (x.vlan = Number(e.target.value)))} /></Field>
      <Field label="Subnet"><input className="mono" value={s.subnet} onChange={(e) => onChange((x) => (x.subnet = e.target.value))} /></Field>
      {wifi && <Field label="Wi-Fi name"><input value={s.ssid} onChange={(e) => onChange((x) => (x.ssid = e.target.value))} /></Field>}
    </>
  );
}
