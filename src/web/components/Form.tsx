import type { ReactNode } from "react";
import "../views/plan.css";

// Form pieces shared by the setup generator and the change page. Styles: plan.css (pv-).

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Section({ title, sub, toggle, onToggle, children }: { title: string; sub?: string; toggle?: boolean; onToggle?: (v: boolean) => void; children: ReactNode }) {
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => <button key={v} type="button" className={value === v ? "on" : undefined} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
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
