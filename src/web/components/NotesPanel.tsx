import { useState } from "react";
import { KIND_LABEL, KINDS, type DeviceKind } from "../../core/classify.ts";
import type { ServiceNote } from "../../core/ros.ts";
import { saveDeviceNotes, type Device } from "../api.ts";

/** Notes for one device: what people and agents told Stribog. View, then edit in place. */
export function NotesPanel({ d, onSaved }: { d: Device; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  if (!d.mac) return null;
  const noted = d.nameSource === "user" || d.kindCertainty === "user" || d.labels?.length || d.description || d.services?.length || d.notes;

  if (editing) return <NotesForm d={d} onDone={(saved) => (setEditing(false), saved && onSaved())} />;
  return (
    <div>
      <div className="sec-title" style={{ marginTop: 0 }}>
        Notes
        <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setEditing(true)}>{noted ? "Edit" : "Add"}</button>
      </div>
      {!noted ? (
        <p className="faint notes-empty">Nothing noted yet. Give it a name, labels, a short description, what runs on it. Agents connected in Settings can add notes too.</p>
      ) : (
        <div className="notes">
          {d.description && <p className="notes-desc">{d.description}</p>}
          {d.labels?.length ? <div className="notes-labels">{d.labels.map((l) => <span key={l} className="chip">{l}</span>)}</div> : null}
          {d.services?.length ? (
            <div className="notes-services">
              {d.services.map((s, i) => (
                <div key={i}>
                  <b>{s.url ? <a href={s.url} target="_blank" rel="noreferrer noopener">{s.name}</a> : s.name}</b>
                  {s.port || s.protocol ? <span className="mono faint"> {[s.port, s.protocol].filter(Boolean).join("/")}</span> : null}
                  {s.note ? <span className="faint"> · {s.note}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          {d.notes && <p className="notes-text">{d.notes}</p>}
        </div>
      )}
    </div>
  );
}

type Row = { name: string; port: string; protocol: string; url: string; note: string };
const toRow = (s: ServiceNote): Row => ({ name: s.name, port: s.port ? String(s.port) : "", protocol: s.protocol ?? "", url: s.url ?? "", note: s.note ?? "" });

function NotesForm({ d, onDone }: { d: Device; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState(d.nameSource === "user" ? d.name : "");
  const [kind, setKind] = useState(d.kindCertainty === "user" ? d.kind : "");
  const [labels, setLabels] = useState((d.labels ?? []).join(", "));
  const [description, setDescription] = useState(d.description ?? "");
  const [services, setServices] = useState<Row[]>((d.services ?? []).map(toRow));
  const [notes, setNotes] = useState(d.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const setRow = (i: number, k: keyof Row, v: string) => setServices((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    setBusy(true);
    const err = await saveDeviceNotes(d.mac!, {
        name: name.trim() || null,
        kind: kind || null,
        labels: labels.split(",").map((l) => l.trim()).filter(Boolean),
        description: description.trim() || null,
        services: services
          .filter((r) => r.name.trim())
          .map((r) => ({ name: r.name.trim(), ...(r.port.trim() ? { port: Number(r.port) } : {}), ...(r.protocol.trim() ? { protocol: r.protocol.trim() } : {}), ...(r.url.trim() ? { url: r.url.trim() } : {}), ...(r.note.trim() ? { note: r.note.trim() } : {}) })),
        notes: notes.trim() || null,
    });
    setBusy(false);
    setError(err);
    if (!err) onDone(true);
  };

  return (
    <form
      className="notes-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => e.key === "Escape" && onDone(false)}
    >
      <div className="sec-title" style={{ marginTop: 0 }}>Notes</div>
      <label>
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={d.nameSource === "user" ? "" : `${d.name} (from the router)`} maxLength={80} autoFocus />
      </label>
      <label>
        <span>Kind</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">{d.kindCertainty === "user" ? "Let Stribog guess" : `Stribog's guess: ${KIND_LABEL[d.kind as DeviceKind] ?? d.kind}`}</option>
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label>
        <span>Labels</span>
        <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Comma-separated: a room, an owner, a role" />
      </label>
      <label>
        <span>Description</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="What it is and what it is for" />
      </label>
      <div className="notes-form-services">
        <span>Services</span>
        {services.map((r, i) => (
          <div key={i} className="svc-row">
            <input value={r.name} onChange={(e) => setRow(i, "name", e.target.value)} placeholder="Name" aria-label="Service name" />
            <input className="mono" value={r.port} onChange={(e) => setRow(i, "port", e.target.value.replace(/\D/g, ""))} placeholder="Port" aria-label="Port" inputMode="numeric" />
            <input className="mono" value={r.url} onChange={(e) => setRow(i, "url", e.target.value)} placeholder="http://… (optional)" aria-label="URL" />
            <button type="button" className="btn ghost sm" aria-label="Remove service" onClick={() => setServices((rs) => rs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="btn ghost sm" onClick={() => setServices((rs) => [...rs, { name: "", port: "", protocol: "", url: "", note: "" }])}>+ Add a service</button>
      </div>
      <label>
        <span>Notes</span>
        <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth knowing later" />
      </label>
      {error && <p className="notes-error" role="alert">{error}</p>}
      <div className="notes-actions">
        <button type="button" className="btn ghost" onClick={() => onDone(false)}>Cancel</button>
        <button className="btn pri" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}
