import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { KIND_LABEL, type DeviceKind } from "../../core/classify.ts";
import { fmtBps } from "../../core/net.ts";
import { fetchActivity, type DeviceActivity, type NetworkPayload } from "../api.ts";
import { Glyph } from "../components/DeviceArt.tsx";
import "./device.css";

type Flow = DeviceActivity["now"]["flows"][number];
type Talk = DeviceActivity["history"]["talks"][number];
type Sample = DeviceActivity["history"]["samples"][number];

const RANGES = [
  { hours: 24, label: "24 hours" },
  { hours: 24 * 7, label: "7 days" },
];

/** A device's activity: traffic over time, who it talks to now, and who it talked to. */
export function DeviceView({ data, id, onBack, onSelect }: { data: NetworkPayload; id: string; onBack: () => void; onSelect: (id: string) => void }) {
  const d = data.model.devices.find((x) => x.id === id);
  const [hours, setHours] = useState(24);
  const [act, setAct] = useState<DeviceActivity>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const load = () =>
      fetchActivity(id, hours).then(
        (a) => live && (setAct(a), setError(undefined)),
        (e: Error) => live && setError(e.message),
      );
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id, hours]);

  if (!d) return <div className="page"><p className="muted">This device is no longer in the network.</p></div>;
  const h = act?.history;
  const step = h && h.samples.length > 1 ? medianStep(h.samples) : 60_000;
  const moved = h?.samples.length ? totals(h.samples, step) : undefined;
  const onlineShare = h && h.samples.length ? h.samples.filter((s) => s[1]).length / h.samples.length : undefined;
  const now = act?.now.flows ?? [];
  const parent = d.parent ? data.model.devices.find((x) => x.id === d.parent) : undefined;

  return (
    <div className="page dv">
      <button className="linkish dv-back" onClick={onBack}>← Map</button>
      <header className="dv-head">
        <div className="dv-ic"><Glyph kind={d.kind} size={28} /></div>
        <div>
          <h1>{d.name}</h1>
          <p className="muted">
            {KIND_LABEL[d.kind as DeviceKind] ?? d.kind}
            {d.kindCertainty === "inferred" && d.kind !== "unknown" ? " (probably)" : ""} · <span className={d.status === "online" ? "ok" : undefined}>{d.status}</span>
            {d.ip ? <> · <span className="mono">{d.ip}</span></> : null}
            {d.mac ? <> · <span className="mono">{d.mac}</span></> : null}
            {d.vendor ? <> · {d.vendor}</> : null}
            {parent ? <> · via {parent.name}{d.via?.kind === "wifi" ? ` (${d.via.band} GHz, ${d.via.signal ?? "?"} dBm)` : d.via?.port ? ` (${d.via.port})` : ""}</> : null}
          </p>
        </div>
      </header>

      <div className="seg dv-range" role="radiogroup" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r.hours} role="radio" aria-checked={hours === r.hours} className={hours === r.hours ? "on" : undefined} onClick={() => setHours(r.hours)}>{r.label}</button>
        ))}
      </div>

      <div className="dv-tiles">
        <Tile label="Traffic now" value={trafficNow(d) ?? "—"} />
        <Tile label={`Moved, last ${hours === 24 ? "24 hours" : "7 days"}`} value={moved ? `↓ ${fmtBytes(moved.down)} · ↑ ${fmtBytes(moved.up)}` : "—"} note={moved ? "from what Stribog recorded" : undefined} />
        <Tile label="Online" value={onlineShare === undefined ? "—" : `${Math.round(onlineShare * 100)}%`} note={onlineShare === undefined ? undefined : "of the recorded time"} />
        <Tile label="Talking to now" value={`${now.length}`} note={now.length ? `${now.filter((f) => f.scope === "internet").length} on the internet` : undefined} />
      </div>

      <section className="card dv-sec">
        <div className="dv-sec-h">
          <h2>Traffic</h2>
          <Legend />
        </div>
        {error ? <p className="dv-error">{error}</p> : !h ? <p className="faint">Loading…</p> : h.samples.length < 2 ? <Empty h={h} /> : <TrafficChart h={h} step={step} />}
        {h && <Recording h={h} />}
      </section>

      <section className="card dv-sec">
        <div className="dv-sec-h"><h2>Talking to now</h2></div>
        {act?.now.note && !now.length ? <p className="faint">{act.now.note}</p> : now.length ? <FlowTable rows={now} onSelect={onSelect} /> : <p className="faint">No connections through the router right now.</p>}
        {act?.now.note && now.length ? <p className="faint dv-foot">{act.now.note}</p> : null}
        {act?.now.noNames && <p className="faint dv-foot">{act.now.noNames}</p>}
        <p className="faint dv-foot">
          From the router's connection tracking: only traffic the router routes (to the internet or between networks) shows here, not devices talking to each other on the same LAN.
          {now.some((f) => f.fasttracked) ? " Some connections are fast-tracked, so the router counts only part of their bytes." : ""} Port names are what a port is usually for.
        </p>
      </section>

      <section className="card dv-sec">
        <div className="dv-sec-h"><h2>Talked to, last {hours === 24 ? "24 hours" : "7 days"}</h2></div>
        {h?.talks.length ? <FlowTable rows={h.talks} onSelect={onSelect} history /> : <p className="faint">Nothing recorded for this device in this period.</p>}
      </section>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card dv-tile">
      <small>{label}</small>
      <b>{value}</b>
      {note && <span className="faint">{note}</span>}
    </div>
  );
}

function Legend() {
  return (
    <div className="dv-legend" aria-label="Legend">
      <span><i style={{ background: "var(--chart-down)" }} />Download (to the device)</span>
      <span><i style={{ background: "var(--chart-up)" }} />Upload (from it)</span>
    </div>
  );
}

function Empty({ h }: { h: DeviceActivity["history"] }) {
  return <p className="faint">{h.recording ? "Recording has started; the chart fills in as minutes pass." : "Nothing recorded for this period yet."}</p>;
}

function Recording({ h }: { h: DeviceActivity["history"] }) {
  return (
    <p className="faint dv-foot">
      {h.recording ? "Recording now. " : ""}Stribog records once a minute while someone is signed in to the router, for up to 12 hours after the last visit, and keeps 30 days.
      {h.since ? ` Recorded since ${new Date(h.since).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.` : ""}
    </p>
  );
}

// ---- traffic chart ---------------------------------------------------------------

const H = 220;
const PAD = { l: 64, r: 16, t: 12, b: 26 };

/** Download and upload over time on one axis, with an online strip under it and a hover readout. */
function TrafficChart({ h, step }: { h: DeviceActivity["history"]; step: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number>();
  const [table, setTable] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(320, el.clientWidth));
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const s = h.samples;
  const { max, ticks } = niceScale(Math.max(1000, ...s.map((x) => Math.max(x[2] ?? 0, x[3] ?? 0))));
  const x = (t: number) => PAD.l + ((t - h.from) / (h.to - h.from)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const timeTicks = useMemo(() => timeTicksFor(h.from, h.to), [h.from, h.to]);

  // Lines break where nothing was recorded, so a gap reads as "not recording", not as zero.
  const segments = (i: 2 | 3) => {
    const out: string[] = [];
    let cur = "";
    s.forEach((p, k) => {
      const v = p[i];
      const gap = k > 0 && p[0] - s[k - 1]![0] > step * 3;
      if (v === null || gap) {
        if (cur) out.push(cur);
        cur = "";
      }
      if (v !== null) cur += `${cur ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(v).toFixed(1)} `;
    });
    if (cur) out.push(cur);
    return out;
  };
  const area = segments(2).map((d) => {
    const pts = d.trim().split(/[ML]/).filter(Boolean).map((p) => p.trim().split(" ").map(Number));
    return `${d}L${pts.at(-1)![0]} ${y(0)} L${pts[0]![0]} ${y(0)} Z`;
  });

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const t = h.from + ((e.clientX - r.left) / r.width) * (h.to - h.from);
    let best = 0;
    for (let k = 1; k < s.length; k++) if (Math.abs(s[k]![0] - t) < Math.abs(s[best]![0] - t)) best = k;
    setHover(best);
  };
  const hp = hover !== undefined ? s[hover] : undefined;

  if (table)
    return (
      <>
        <button className="linkish" onClick={() => setTable(false)}>Show as chart</button>
        <div className="dv-tablewrap">
          <table className="t dv-t">
            <thead><tr><th>Time</th><th>Online</th><th>Download</th><th>Upload</th><th>Signal</th></tr></thead>
            <tbody>
              {[...s].reverse().map((p) => (
                <tr key={p[0]}>
                  <td className="mono">{new Date(p[0]).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{p[1] ? "online" : "offline"}</td>
                  <td className="mono">{p[2] === null ? "—" : fmtBps(p[2])}</td>
                  <td className="mono">{p[3] === null ? "—" : fmtBps(p[3])}</td>
                  <td className="mono">{p[4] === null ? "—" : `${p[4]} dBm`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );

  return (
    <div ref={ref} className="dv-chart">
      <svg width={w} height={H + 22} role="img" aria-label="Download and upload over time">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--hair)" />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="dv-axis">{v === 0 ? "0" : fmtBps(v)}</text>
          </g>
        ))}
        {timeTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="dv-axis">{tickLabel(t, h.to - h.from)}</text>
        ))}
        {area.map((d, k) => <path key={k} d={d} fill="var(--chart-down)" opacity={0.1} />)}
        {segments(2).map((d, k) => <path key={`d${k}`} d={d} fill="none" stroke="var(--chart-down)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {segments(3).map((d, k) => <path key={`u${k}`} d={d} fill="none" stroke="var(--chart-up)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}

        {/* Online strip: one mark per recorded minute (or bucket); blank where nothing was recorded. */}
        <text x={PAD.l - 8} y={H + 15} textAnchor="end" className="dv-axis">online</text>
        {s.map((p, k) => (
          <rect key={p[0]} x={x(p[0])} y={H + 7} width={Math.max(1, x(p[0] + step) - x(p[0]) - (k < s.length - 1 ? 0.5 : 0))} height={10} rx={1} fill={p[1] ? "var(--ok)" : "var(--hair-2)"} opacity={p[1] ? 0.75 : 1} />
        ))}

        {hp && (
          <g pointerEvents="none">
            <line x1={x(hp[0])} x2={x(hp[0])} y1={PAD.t} y2={H - PAD.b} stroke="var(--tx-3)" strokeWidth={1} />
            {hp[2] !== null && <circle cx={x(hp[0])} cy={y(hp[2])} r={4} fill="var(--chart-down)" stroke="var(--ink-2)" strokeWidth={2} />}
            {hp[3] !== null && <circle cx={x(hp[0])} cy={y(hp[3])} r={4} fill="var(--chart-up)" stroke="var(--ink-2)" strokeWidth={2} />}
          </g>
        )}
        <rect x={PAD.l} y={0} width={w - PAD.l - PAD.r} height={H + 22} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(undefined)} />
      </svg>
      {hp && (
        <div className="dv-tip" style={{ left: Math.min(w - 190, x(hp[0]) + 12) }}>
          <b>{new Date(hp[0]).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</b>
          <span><i style={{ background: "var(--chart-down)" }} />Download <span className="mono">{hp[2] === null ? "—" : fmtBps(hp[2])}</span></span>
          <span><i style={{ background: "var(--chart-up)" }} />Upload <span className="mono">{hp[3] === null ? "—" : fmtBps(hp[3])}</span></span>
          <span className="faint">{hp[1] ? "online" : "offline"}{hp[4] !== null ? ` · ${hp[4]} dBm` : ""}</span>
        </div>
      )}
      <button className="linkish" onClick={() => setTable(true)}>Show as table</button>
    </div>
  );
}

// ---- tables ------------------------------------------------------------------

function FlowTable({ rows, history, onSelect }: { rows: (Flow | Talk)[]; history?: boolean; onSelect: (id: string) => void }) {
  return (
    <div className="dv-tablewrap">
      <table className="t dv-t">
        <thead>
          <tr>
            <th>Other end</th>
            <th>Where</th>
            <th>Port</th>
            <th className="num">Down</th>
            <th className="num">Up</th>
            {history ? <th>Seen</th> : <th className="num">Connections</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={`${f.direction}|${f.protocol}|${f.remote}|${f.port}`}>
              <td>
                {f.remoteDevice ? (
                  <a href="#" onClick={(e) => (e.preventDefault(), onSelect(f.remoteDevice!.id))}>{f.remoteDevice.name}</a>
                ) : f.names?.length ? (
                  <span title={f.names.join(" → ")}>{f.names[0]}</span>
                ) : (
                  <span className="faint">no name known</span>
                )}
                <span className="mono faint"> {f.remote}</span>
                {f.direction === "in" ? <span className="cert">incoming</span> : null}
              </td>
              <td>{f.scope === "internet" ? "Internet" : "This network"}</td>
              <td>
                <span className="mono">{f.port ? `${f.port}/${f.protocol}` : f.protocol}</span>
                {f.service ? <span className="faint"> · usually {f.service}</span> : null}
              </td>
              <td className="num mono">{fmtBytes(f.down)}</td>
              <td className="num mono">{fmtBytes(f.up)}</td>
              {history ? (
                <td className="faint">{seen(f as Talk)}</td>
              ) : (
                <td className="num mono">{(f as Flow).connections}{(f as Flow).fasttracked ? <span className="cert">fast-tracked</span> : null}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------------

function trafficNow(d: NetworkPayload["model"]["devices"][number]): string | undefined {
  const v = d.via;
  if (v?.downBps === undefined && v?.upBps === undefined) return undefined;
  return `↓ ${fmtBps(v?.downBps ?? 0)} · ↑ ${fmtBps(v?.upBps ?? 0)}`;
}

function medianStep(s: Sample[]): number {
  const gaps = s.slice(1).map((p, k) => p[0] - s[k]![0]).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 60_000;
}

/** Bytes moved, integrating each sample's rate over its interval (gaps count as nothing). */
function totals(s: Sample[], step: number): { down: number; up: number } {
  let down = 0;
  let up = 0;
  for (const p of s) {
    down += ((p[2] ?? 0) * step) / 8000;
    up += ((p[3] ?? 0) * step) / 8000;
  }
  return { down, up };
}

export function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`;
  return `${Math.round(b)} B`;
}

/** About four round steps (1, 2, 2.5 or 5 × 10ⁿ) from zero to just above the largest value. */
function niceScale(v: number): { max: number; ticks: number[] } {
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw)!;
  const max = Math.ceil(v / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, k) => k * step) };
}

function timeTicksFor(from: number, to: number): number[] {
  const span = to - from;
  const every = span <= 26 * 3600_000 ? 3 * 3600_000 : 24 * 3600_000;
  const first = Math.ceil(from / every) * every;
  const out: number[] = [];
  for (let t = first; t <= to; t += every) out.push(t);
  return out;
}

const tickLabel = (t: number, span: number) =>
  span <= 26 * 3600_000 ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });

function seen(t: Talk): string {
  const f = new Date(t.first);
  const l = new Date(t.last);
  const fmt = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return t.first === t.last ? fmt(l) : `${fmt(f)} – ${fmt(l)}`;
}
