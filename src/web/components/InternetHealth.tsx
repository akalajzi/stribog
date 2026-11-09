import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { STATE_TEXT, WHERE_TEXT, type Episode, type NetSample, type NetState } from "../../core/internet.ts";
import { useInternet, type InternetHistory } from "../api.ts";
import { niceScale, tickLabel, timeTicksFor } from "../chart.ts";
import "../views/device.css";

// "Is it me or my provider?": the router's own check of the internet, once a minute, over a day
// or a week. Colour carries the state of each minute and the two round-trip series, nothing else.

const RANGES = [
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
];

export const STATE_VAR: Record<NetState, string> = { up: "var(--ok)", unsteady: "var(--warn)", down: "var(--bad)", unread: "var(--tx-3)" };

export function InternetHealth() {
  const [hours, setHours] = useState(24);
  const { data: h, error } = useInternet(hours);
  return (
    <section className="card dv-sec ih" id="internet-health">
      <div className="dv-sec-h">
        <h2>Internet over time</h2>
        <div className="seg" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.hours} role="radio" aria-checked={hours === r.hours} className={hours === r.hours ? "on" : undefined} onClick={() => setHours(r.hours)}>{r.label}</button>
          ))}
        </div>
      </div>
      {error && !h ? <p className="dv-error">{error}</p> : !h ? <p className="faint">Loading…</p> : <Body h={h} hours={hours} />}
    </section>
  );
}

function Body({ h, hours }: { h: InternetHistory; hours: number }) {
  const outages = h.episodes.filter((e) => e.state === "down");
  const downMin = outages.reduce((t, e) => t + minutes(e), 0);
  return (
    <>
      <div className="dv-tiles">
        <Tile label="Now" value={h.now ? STATE_TEXT[h.now.s] : "—"} color={h.now && STATE_VAR[h.now.s]} note={h.now?.w ? WHERE_TEXT[h.now.w].short : h.now ? `checked ${new Date(h.now.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "not checked recently"} />
        <Tile
          label={`Outages, last ${hours === 24 ? "24 hours" : "7 days"}`}
          value={h.minutes.recorded ? String(outages.length) : "—"}
          note={outages.length ? `${fmtMinutes(downMin)} without internet` : h.minutes.recorded ? `none in ${fmtMinutes(h.minutes.recorded)} recorded` : undefined}
        />
        <Tile label="Round trip to the internet" value={h.latency ? `${fmtMs(h.latency.median)}` : "—"} note={h.latency ? `typical; the slowest 5% above ${fmtMs(h.latency.p95)}` : undefined} />
        <Tile label="To the provider's gateway" value={h.gatewayLatency ? fmtMs(h.gatewayLatency.median) : "—"} note={h.gatewayLatency ? "typical" : h.gateway ? "it does not answer pings" : "not known"} />
      </div>

      {h.samples.length < 2 ? (
        <p className="faint">{h.recording ? "Checking has started; the chart fills in as minutes pass." : "Nothing recorded for this period yet."}</p>
      ) : (
        <>
          <Legend />
          <Chart h={h} />
        </>
      )}

      {h.episodes.length > 0 && <Episodes list={h.episodes} />}

      <p className="faint dv-foot">
        Once a minute the router pings {h.gateway ? <>its provider's gateway (<span className="mono">{h.gateway}</span>) and </> : null}two public addresses (Cloudflare's 1.1.1.1 and
        Google's 8.8.8.8). Which of them answer says where a fault is: the cable to the provider's box, the box, or the provider's network beyond it. Places marked
        "probably" are inferred from those answers. If the internet is fine here but slow on one device, the problem is between that device and the router: look at
        its Wi-Fi signal on its page.
      </p>
      <p className="faint dv-foot">
        {h.recording ? "Checking now. " : ""}Stribog checks from when someone signs in to the router until they sign out or Stribog restarts, and keeps 30 days.
        {h.since ? ` Checked since ${new Date(h.since).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.` : ""}
      </p>
    </>
  );
}

function Tile({ label, value, note, color }: { label: string; value: string; note?: string; color?: string }) {
  return (
    <div className="card dv-tile">
      <small>{label}</small>
      <b>
        {color && <span className="dot" style={{ background: color, boxShadow: "none", display: "inline-block", marginRight: 8, verticalAlign: "middle" }} />}
        {value}
      </b>
      {note && <span className="faint">{note}</span>}
    </div>
  );
}

function Legend() {
  return (
    <div className="dv-legend ih-legend" aria-label="Legend">
      <span><i style={{ background: "var(--chart-down)" }} />Round trip to the internet</span>
      <span><i style={{ background: "var(--chart-up)" }} />To the provider's gateway</span>
      {(["up", "unsteady", "down", "unread"] as NetState[]).map((s) => (
        <span key={s}><i className="ih-sq" style={{ background: STATE_VAR[s] }} />{STATE_TEXT[s].toLowerCase()}</span>
      ))}
    </div>
  );
}

function Episodes({ list }: { list: Episode[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, 6);
  return (
    <div className="ih-episodes">
      {shown.map((e) => (
        <div key={e.from} className="ih-ep">
          <span className="dot" style={{ background: STATE_VAR[e.state], boxShadow: "none" }} />
          <span className="mono ih-when">{span(e)}</span>
          <span>
            <b>{STATE_TEXT[e.state]}</b> for {fmtMinutes(minutes(e))}
            {e.ongoing ? " (still going)" : ""}
            {e.where ? <span className="faint"> · {WHERE_TEXT[e.where].long}</span> : e.state === "unsteady" ? <span className="faint"> · The internet answered, but lost packets: calls and games stutter.</span> : null}
          </span>
        </div>
      ))}
      {list.length > shown.length && <button className="linkish" onClick={() => setAll(true)}>Show all {list.length}</button>}
    </div>
  );
}

// ---- chart ---------------------------------------------------------------------

const H = 180;
const PAD = { l: 56, r: 16, t: 12, b: 26 };

function Chart({ h }: { h: InternetHistory }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.max(220, el.clientWidth));
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const s = h.samples;
  const step = useMemo(() => medianStep(s), [s]);
  const { max, ticks } = niceScale(Math.max(10, ...s.map((x) => Math.max(x.n?.[2] ?? 0, x.g?.[2] ?? 0))));
  const x = (t: number) => PAD.l + ((t - h.from) / (h.to - h.from)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  // Every tick's label needs about 60 px; on a narrow screen every second or third is shown.
  const timeTicks = useMemo(() => {
    const all = timeTicksFor(h.from, h.to);
    const every = Math.max(1, Math.ceil((60 * all.length) / Math.max(1, w - PAD.l - PAD.r)));
    return all.filter((_, k) => k % every === 0);
  }, [h.from, h.to, w]);

  // Lines break where nothing answered or nothing was recorded.
  const line = (k: "n" | "g") => {
    let d = "";
    let open = false;
    s.forEach((p, i) => {
      const v = p[k]?.[2];
      if (v == null || (i > 0 && p.t - s[i - 1]!.t > step * 3)) open = false;
      if (v == null) return;
      d += `${open ? "L" : "M"}${x(p.t).toFixed(1)} ${y(v).toFixed(1)} `;
      open = true;
    });
    return d;
  };

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = h.from + ((e.clientX - r.left) / r.width) * (h.to - h.from);
    let best = 0;
    for (let k = 1; k < s.length; k++) if (Math.abs(s[k]!.t - t) < Math.abs(s[best]!.t - t)) best = k;
    setHover(best);
  };
  const hp = hover !== undefined ? s[hover] : undefined;

  return (
    <div ref={ref} className="dv-chart">
      <svg width={w} height={H + 22} role="img" aria-label="Round trip to the internet and to the provider's gateway over time, with the state of each minute">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--hair)" />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="dv-axis">{v === 0 ? "0" : `${v} ms`}</text>
          </g>
        ))}
        {timeTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="dv-axis">{tickLabel(t, h.to - h.from)}</text>
        ))}
        <path d={line("g")} fill="none" stroke="var(--chart-up)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        <path d={line("n")} fill="none" stroke="var(--chart-down)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* One mark per recorded minute (or bucket), in the state's colour; blank where nothing was recorded. */}
        {s.map((p, k) => (
          <rect key={p.t} x={x(p.t)} y={H + 7} width={Math.max(1, x(p.t + step) - x(p.t) - (k < s.length - 1 ? 0.25 : 0))} height={10} fill={STATE_VAR[p.s]} opacity={p.s === "up" ? 0.6 : 1} />
        ))}

        {hp && (
          <g pointerEvents="none">
            <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={H + 17} stroke="var(--tx-3)" strokeWidth={1} />
            {hp.n?.[2] != null && <circle cx={x(hp.t)} cy={y(hp.n[2])} r={4} fill="var(--chart-down)" stroke="var(--ink-2)" strokeWidth={2} />}
            {hp.g?.[2] != null && <circle cx={x(hp.t)} cy={y(hp.g[2])} r={3.5} fill="var(--chart-up)" stroke="var(--ink-2)" strokeWidth={2} />}
          </g>
        )}
        <rect x={PAD.l} y={0} width={Math.max(0, w - PAD.l - PAD.r)} height={H + 22} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(undefined)} />
      </svg>
      {hp && <Tip p={hp} left={Math.min(w - 230, x(hp.t) + 12)} bucket={step > 90_000} />}
    </div>
  );
}

function Tip({ p, left, bucket }: { p: NetSample; left: number; bucket: boolean }) {
  const loss = (x?: [number, number, number | null]) => (x && x[0] ? Math.round((1 - x[1] / x[0]) * 100) : undefined);
  return (
    <div className="dv-tip" style={{ left: Math.max(0, left), minWidth: 210 }}>
      <b>{new Date(p.t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</b>
      <span>
        <i className="ih-sq" style={{ background: STATE_VAR[p.s] }} />
        {STATE_TEXT[p.s]}
        {bucket && p.s !== "up" ? " (at some point)" : ""}
      </span>
      {p.w && <span className="faint">{WHERE_TEXT[p.w].short}</span>}
      <span><i style={{ background: "var(--chart-down)" }} />Internet <span className="mono">{p.n?.[2] != null ? fmtMs(p.n[2]) : "no answer"}{loss(p.n) ? ` · ${loss(p.n)}% lost` : ""}</span></span>
      {p.g && <span><i style={{ background: "var(--chart-up)" }} />Gateway <span className="mono">{p.g[2] != null ? fmtMs(p.g[2]) : "no answer"}</span></span>}
      {bucket && <span className="faint">Slowest minute of this stretch</span>}
    </div>
  );
}

// ---- formatting ----------------------------------------------------------------

function medianStep(s: NetSample[]): number {
  const gaps = s.slice(1).map((p, k) => p.t - s[k]!.t).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 60_000;
}

const minutes = (e: Episode) => Math.max(1, Math.round((e.to - e.from) / 60_000));

export function fmtMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export const fmtMs = (v: number) => (v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);

function span(e: Episode): string {
  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return day(e.from) === day(e.to) ? `${day(e.from)}, ${time(e.from)}–${time(e.to)}` : `${day(e.from)} ${time(e.from)} – ${day(e.to)} ${time(e.to)}`;
}
