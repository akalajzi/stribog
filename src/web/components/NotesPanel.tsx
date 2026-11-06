import { useState, type ReactNode } from "react";
import { KIND_LABEL, KINDS, type DeviceKind } from "../../core/classify.ts";
import type { ServiceNote } from "../../core/ros.ts";
import { fmtBps } from "../../core/net.ts";
import { linkCounters } from "../../core/model.ts";
import { saveDeviceNotes, type Device, type NetworkModel } from "../api.ts";
import { bandColor } from "./DeviceArt.tsx";

// Everything people (or their agents) tell Stribog about a device, each part with its own
// control: rename next to the name, labels and description under it, then services and notes.

type Saved = () => void;

/** Save one change; returns an error message or undefined. */
async function save(d: Device, patch: Record<string, unknown>, onSaved: Saved): Promise<string | undefined> {
  const err = await saveDeviceNotes(d.mac!, patch);
  if (!err) onSaved();
  return err;
}

/** The device's name in the inspector header, with a Rename button. */
export function DeviceTitle({ d, onSaved }: { d: Device; onSaved: Saved }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const canEdit = !!d.mac;

  if (!editing)
    return (
      <div className="title-row">
        <h2>{d.name}</h2>
        {canEdit && (
          <button
            className="btn ghost sm rename"
            title="Rename"
            aria-label="Rename"
            onClick={() => {
              setName(d.nameSource === "user" ? d.name : "");
              setError(undefined);
              setEditing(true);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
          </button>
        )}
      </div>
    );

  return (
    <form
      className="rename-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const err = await save(d, { name: name.trim() || null }, onSaved);
        setError(err);
        if (!err) setEditing(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={d.nameSource === "user" ? "Name" : `${d.name} (from the router)`} maxLength={80} autoFocus aria-label="Name" />
      {error && <p className="notes-error">{error}</p>}
      <div className="notes-actions">
        <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>Cancel</button>
        <button className="btn pri sm">Save</button>
      </div>
      <p className="faint notes-hint">Leave the name empty to use what the router reports.</p>
    </form>
  );
}

/**
 * The device's kind, changed in place: a menu that looks like the label, saved on choice.
 * "Let Stribog guess" clears what a person chose.
 */
export function DeviceKindPicker({ d, onSaved }: { d: Device; onSaved: Saved }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const label = KIND_LABEL[d.kind as DeviceKind] ?? d.kind;
  if (!d.mac) return <>{label}</>;
  const chosen = d.kindCertainty === "user";
  return (
    <>
      <select
        className="kind-select"
        value={chosen ? d.kind : ""}
        disabled={busy}
        aria-label="Device kind"
        title="Change the kind"
        onChange={async (e) => {
          setBusy(true);
          setError(await save(d, { kind: e.target.value || null }, onSaved));
          setBusy(false);
        }}
      >
        <option value="">{chosen ? "Let Stribog guess" : label}</option>
        {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      {error && <span className="notes-error"> {error}</span>}
    </>
  );
}

/** Labels as chips you can add and remove, and the short description. */
export function DeviceAbout({ d, onSaved }: { d: Device; onSaved: Saved }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [describing, setDescribing] = useState(false);
  const [desc, setDesc] = useState("");
  const [error, setError] = useState<string>();
  if (!d.mac) return null;
  const labels = d.labels ?? [];
  const setLabels = async (next: string[]) => setError(await save(d, { labels: next.length ? next : null }, onSaved));

  return (
    <div className="about">
      {describing ? (
        <Inline
          onCancel={() => setDescribing(false)}
          onSave={async () => {
            const err = await save(d, { description: desc.trim() || null }, onSaved);
            setError(err);
            if (!err) setDescribing(false);
          }}
        >
          <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} placeholder="What it is and what it is for" autoFocus aria-label="Description" />
        </Inline>
      ) : d.description ? (
        <p className="about-desc" onClick={() => (setDesc(d.description ?? ""), setDescribing(true))} title="Click to edit">{d.description}</p>
      ) : (
        <button className="linkish" onClick={() => (setDesc(""), setDescribing(true))}>+ Description</button>
      )}

      <div className="about-labels">
        {labels.map((l) => (
          <span key={l} className="chip label-chip">
            {l}
            <button aria-label={`Remove label ${l}`} onClick={() => void setLabels(labels.filter((x) => x !== l))}>×</button>
          </span>
        ))}
        {adding ? (
          <form
            className="label-add"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = label.trim();
              if (v && !labels.includes(v)) await setLabels([...labels, v]);
              setLabel("");
              setAdding(false);
            }}
          >
            <input value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => !label.trim() && setAdding(false)} onKeyDown={(e) => e.key === "Escape" && setAdding(false)} placeholder="Room, owner, role…" maxLength={40} autoFocus aria-label="New label" />
          </form>
        ) : (
          <button className="linkish" onClick={() => setAdding(true)}>+ Label</button>
        )}
      </div>
      {error && <p className="notes-error">{error}</p>}
    </div>
  );
}

type Row = { name: string; port: string; url: string };

/** What runs on the device. */
export function DeviceServices({ d, onSaved }: { d: Device; onSaved: Saved }) {
  const [row, setRow] = useState<Row>();
  const [error, setError] = useState<string>();
  if (!d.mac) return null;
  const services = d.services ?? [];
  const write = async (next: ServiceNote[]) => {
    const err = await save(d, { services: next.length ? next : null }, onSaved);
    setError(err);
    return err;
  };

  return (
    <div>
      <div className="sec-title" style={{ marginTop: 0 }}>
        Services
        {!row && <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setRow({ name: "", port: "", url: "" })}>+ Add service</button>}
      </div>
      {services.length > 0 && (
        <div className="notes-services">
          {services.map((s, i) => (
            <div key={i} className="svc">
              <b>{s.url ? <a href={s.url} target="_blank" rel="noreferrer noopener">{s.name}</a> : s.name}</b>
              {s.port || s.protocol ? <span className="mono faint"> {[s.port, s.protocol].filter(Boolean).join("/")}</span> : null}
              {s.note ? <span className="faint"> · {s.note}</span> : null}
              <button className="svc-x" aria-label={`Remove ${s.name}`} onClick={() => void write(services.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}
      {!services.length && !row && <p className="faint notes-empty">Nothing yet. Add what runs here, so you and your agents know what depends on it.</p>}
      {row && (
        <Inline
          onCancel={() => setRow(undefined)}
          onSave={async () => {
            if (!row.name.trim()) return setError("A service needs a name.");
            const s: ServiceNote = { name: row.name.trim(), ...(row.port ? { port: Number(row.port) } : {}), ...(row.url.trim() ? { url: row.url.trim() } : {}) };
            if (!(await write([...services, s]))) setRow(undefined);
          }}
        >
          <div className="svc-row">
            <input value={row.name} onChange={(e) => setRow({ ...row, name: e.target.value })} placeholder="Name, e.g. Home Assistant" autoFocus aria-label="Service name" />
            <input className="mono" value={row.port} onChange={(e) => setRow({ ...row, port: e.target.value.replace(/\D/g, "") })} placeholder="Port" inputMode="numeric" aria-label="Port" />
          </div>
          <input className="mono" value={row.url} onChange={(e) => setRow({ ...row, url: e.target.value })} placeholder="http://… (optional)" aria-label="URL" />
        </Inline>
      )}
      {error && <p className="notes-error">{error}</p>}
    </div>
  );
}

/** Free-form notes, and only those. */
export function DeviceNotesText({ d, onSaved }: { d: Device; onSaved: Saved }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  if (!d.mac) return null;
  return (
    <div>
      <div className="sec-title" style={{ marginTop: 0 }}>
        Notes
        {!editing && (
          <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => (setText(d.notes ?? ""), setEditing(true))}>
            {d.notes ? "Edit" : "+ Add note"}
          </button>
        )}
      </div>
      {editing ? (
        <Inline
          onCancel={() => setEditing(false)}
          onSave={async () => {
            const err = await save(d, { notes: text.trim() || null }, onSaved);
            setError(err);
            if (!err) setEditing(false);
          }}
        >
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Anything worth knowing later" autoFocus aria-label="Notes" />
        </Inline>
      ) : d.notes ? (
        <p className="notes-text">{d.notes}</p>
      ) : null}
      {error && <p className="notes-error">{error}</p>}
    </div>
  );
}

function Inline({ children, onSave, onCancel }: { children: ReactNode; onSave: () => void | Promise<unknown>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="notes-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSave();
        setBusy(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      {children}
      <div className="notes-actions">
        <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="btn pri sm" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

/**
 * A machine's connections (cable, Wi-Fi), and the notes that say which connections are one
 * machine: split one Stribog grouped by its DHCP name, or join one it could not know about.
 */
export function DeviceConnections({ d, model, onSaved, onSelect }: { d: Device; model: NetworkModel; onSaved: Saved; onSelect: (id: string) => void }) {
  const [joining, setJoining] = useState(false);
  const [other, setOther] = useState("");
  const [error, setError] = useState<string>();
  if (!d.mac || d.managed || d.id === model.routerId || d.zone !== "lan") return null;
  const links = d.links ?? [];
  const patchAll = async (patches: [string, Record<string, unknown>][]) => {
    for (const [mac, patch] of patches) {
      const err = await saveDeviceNotes(mac, patch);
      if (err) return setError(err);
    }
    setError(undefined);
    onSaved();
  };
  // Splitting one off clears the group's notes that joined them, and keeps it out of DHCP-name grouping.
  const split = (mac: string) => patchAll(links.map((l) => [l.mac, l.mac === mac ? { separate: true, sameAs: null } : { sameAs: null }]));
  const candidates = model.devices.filter((x) => x.mac && x.id !== d.id && !x.managed && x.zone === "lan" && x.id !== model.routerId).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      {links.length > 0 && (
        <>
          <div className="sec-title" style={{ marginTop: 0 }}>Connections</div>
          <div className="links">
            {links.map((l, i) => {
              const parent = model.devices.find((x) => x.id === l.parent);
              const c = linkCounters(model, l) ?? (l.via?.measured ? l.via : undefined);
              const down = c?.downBps;
              const up = c?.upBps;
              return (
                <div key={l.mac} className="link-row">
                  <div className="link-head">
                    <b style={{ color: l.via?.kind === "wifi" ? bandColor(l.via.band) : undefined }}>
                      {l.via?.kind === "wifi" ? `Wi-Fi${l.via.band ? ` ${l.via.band} GHz` : ""}` : l.via?.kind === "port" ? "Cable" : "Connection"}
                    </b>
                    {parent && (
                      <span className="faint">
                        {" via "}
                        <a href="#" onClick={(e) => (e.preventDefault(), onSelect(parent.id))}>{parent.name}</a>
                        {l.via?.kind === "port" && l.via.port ? ` · ${l.via.port}` : l.via?.kind === "wifi" && l.via.signal !== undefined ? ` · ${l.via.signal} dBm` : ""}
                      </span>
                    )}
                    <span className="link-status" style={{ color: l.status === "online" ? "var(--ok)" : "var(--tx-3)" }}>{l.status}</span>
                  </div>
                  <div className="mono faint link-ids">{l.ip ?? "no address"} · {l.mac}</div>
                  {l.status === "online" && (down !== undefined || up !== undefined) && <div className="mono faint link-ids">↓ {fmtBps(down ?? 0)} · ↑ {fmtBps(up ?? 0)} {l.via?.measured ? "through the router, last minute" : "now"}</div>}
                  {l.leaseComment && <div className="faint link-note">“{l.leaseComment}”</div>}
                  {i > 0 && <button className="linkish" onClick={() => void split(l.mac)}>Not the same machine</button>}
                </div>
              );
            })}
          </div>
          <p className="faint notes-hint">
            {d.linkedBy === "user" ? "Shown as one machine because its notes say so." : `Shown as one machine because each connection gives the router the DHCP name “${links[0]?.hostname ?? d.hostname}”. That is a guess: two devices can share a name.`}
          </p>
        </>
      )}
      {joining ? (
        <form
          className="notes-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!other) return setJoining(false);
            await patchAll([[d.mac!, { sameAs: other, separate: null }]]);
            setJoining(false);
          }}
          onKeyDown={(e) => e.key === "Escape" && setJoining(false)}
        >
          <select value={other} onChange={(e) => setOther(e.target.value)} autoFocus aria-label="The same machine as">
            <option value="">Choose its other connection…</option>
            {candidates.map((x) => <option key={x.id} value={x.mac}>{x.name} · {x.ip ?? x.mac}</option>)}
          </select>
          <div className="notes-actions">
            <button type="button" className="btn ghost sm" onClick={() => setJoining(false)}>Cancel</button>
            <button className="btn pri sm" disabled={!other}>Same machine</button>
          </div>
        </form>
      ) : (
        <button className="linkish" onClick={() => (setOther(""), setJoining(true))}>+ Another connection of this machine</button>
      )}
      {error && <p className="notes-error">{error}</p>}
    </div>
  );
}
