import { useEffect, useMemo, useState } from "react";
import type { Category, Finding, NetworkPayload, Severity } from "../api.ts";
import { CATEGORY_LABEL, isOpen, STATUS_LABEL, statusLine } from "../../core/analyze.ts";
import { FindingCard, SEV_LABEL, SEV_VAR } from "../components/FindingCard.tsx";

const ORDER: Severity[] = ["critical", "warning", "suggestion", "info", "pass"];

/** The filter a finding shows under: open, its severity (good), or accepted. */
const filterFor = (f?: Finding): Severity | "open" | "accepted" => (f?.accepted ? "accepted" : f?.severity === "pass" ? "pass" : "open");

/** Every finding, with filters: what to fix, ideas, notes, what is good, and what was accepted. Shown on the home page. */
export function Review({ data, focus, onShow }: { data: NetworkPayload; focus?: string; onShow: (f: Finding) => void }) {
  const { model, analysis } = data;
  const [sev, setSev] = useState(() => filterFor(analysis.findings.find((f) => f.id === focus)));
  const [cat, setCat] = useState<Category | "all">("all");
  const name = (id: string) => model.devices.find((d) => d.id === id)?.name ?? id;

  // Opened for one finding: show the filter it is under and bring it into view.
  useEffect(() => {
    if (!focus) return;
    const f = analysis.findings.find((x) => x.id === focus);
    if (f) {
      setSev(filterFor(f));
      setCat("all");
    }
    setTimeout(() => document.getElementById(`f-${focus}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
    // Only when the focus changes, not on every read of the network.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const visible = useMemo(
    () => analysis.findings.filter((f) => (sev === "open" ? isOpen(f) : sev === "accepted" ? !!f.accepted : f.severity === sev && !f.accepted) && (cat === "all" || f.category === cat)),
    [analysis, sev, cat],
  );
  const cats = [...new Set(analysis.findings.map((f) => f.category))];

  return (
    <div>
      <p className="lede">
        {STATUS_LABEL[analysis.status]}: {statusLine(analysis)} Ideas are optional; accept anything that is fine as it is here. Built from {model.sources.map((s) => s.label.split("/").pop()).join(", ")}
        {data.meta.sample ? ", with sample runtime data until a live router connection is configured" : ""}.
      </p>
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
          <button className={`fchip${sev === "accepted" ? " on" : ""}`} onClick={() => setSev("accepted")} title="Findings you accepted as fine here. They do not count until they change.">
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
        {visible.map((f) => <FindingCard key={f.id} f={f} open={f.id === focus} onShow={onShow} deviceName={name} />)}
        {!visible.length && <div className="card muted" style={{ padding: 16 }}>Nothing here.</div>}
      </div>
    </div>
  );
}
