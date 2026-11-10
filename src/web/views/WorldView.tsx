import { useEffect, useMemo, useRef, useState } from "react";
import { useOwnersNow, type NetworkPayload, type OwnersNow } from "../api.ts";
import type { PlaceNow } from "../../core/activity.ts";
import { fmtBps } from "../../core/net.ts";
import { MAP_H, MAP_W, project } from "../../core/projection.ts";
import { COUNTRIES, LAND, ZONES } from "../../core/world.ts";
import { Flow, level } from "../components/Topology.tsx";
import "./world.css";

/** A place that carried nothing in the latest read stays on the map, faint, this long. */
const KEEP_MS = 2 * 60_000;
/** The side panel's width; the map fits what is left of it. */
const SIDE_W = 380;

const regions = new Intl.DisplayNames(["en"], { type: "region" });
export const countryName = (code?: string) => {
  if (!code) return "Not placed";
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
};

interface Seen {
  place: PlaceNow;
  /** When it last carried traffic. */
  at: number;
  /** It carried traffic in the latest read. */
  now: boolean;
}

/** The latest read's places, and the ones from the last couple of minutes that went quiet. */
function useSeen(now?: OwnersNow): Seen[] {
  const mem = useRef(new Map<string, { place: PlaceNow; at: number }>());
  return useMemo(() => {
    if (!now) return [];
    const m = mem.current;
    for (const p of now.places) m.set(p.country ?? "", { place: p, at: now.at });
    for (const [k, v] of m) if (now.at - v.at > KEEP_MS) m.delete(k);
    const total = (s: Seen) => s.place.downBps + s.place.upBps;
    return [...m.values()].map((v) => ({ ...v, now: v.at === now.at })).sort((a, b) => Number(b.now) - Number(a.now) || (a.now ? total(b) - total(a) : b.at - a.at));
  }, [now]);
}

interface Home {
  at: [number, number];
  /** How Stribog placed it, in words. */
  why: string;
}

/** Where home is drawn. The router does not know; its time zone names a city, its public address a country. */
function homeOf(model: NetworkPayload["model"], now?: OwnersNow): Home | undefined {
  const zone = model.timezone ? ZONES[model.timezone] : undefined;
  if (zone) return { at: project(zone[0], zone[1]), why: `placed at the city of the router's time zone, ${model.timezone}.` };
  const c = now?.addressCountry ? COUNTRIES[now.addressCountry] : undefined;
  if (c) return { at: project(c[0], c[1]), why: `placed in the country the router's internet address is in (${countryName(now!.addressCountry)}), by the same database.` };
  return undefined;
}

type Box = { x: number; y: number; w: number; h: number };
const WORLD: Box = { x: 0, y: 0, w: MAP_W, h: MAP_H };

/** From the place to home, bowed towards the north so arcs read as flights, not lines. */
function arc(from: [number, number], to: [number, number]) {
  const [x1, y1] = from;
  const [x0, y0] = to;
  const dx = x0 - x1;
  const dy = y0 - y1;
  const d = Math.hypot(dx, dy);
  if (d < 4) return undefined;
  let nx = -dy / d;
  let ny = dx / d;
  if (ny > 0) [nx, ny] = [-nx, -ny];
  const h = Math.min(d * 0.28, 110);
  const cx = (x0 + x1) / 2 + nx * h;
  const cy = (y0 + y1) / 2 + ny * h;
  // The length, for dots that move at the same speed on every arc.
  let len = 0;
  let px = x1;
  let py = y1;
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    const x = (1 - t) ** 2 * x1 + 2 * (1 - t) * t * cx + t * t * x0;
    const y = (1 - t) ** 2 * y1 + 2 * (1 - t) * t * cy + t * t * y0;
    len += Math.hypot(x - px, y - py);
    [px, py] = [x, y];
  }
  return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x0.toFixed(1)} ${y0.toFixed(1)}`, len };
}

/** The smallest box around the points, padded, and widened to the screen's shape. */
function fit(points: [number, number][], size: { w: number; h: number }, keep?: Box): Box {
  if (!points.length || !size.w || !size.h) return WORLD;
  // Room for the arcs' bow above and the labels around.
  const pad = 40;
  let x0 = Math.min(...points.map((p) => p[0])) - pad;
  let x1 = Math.max(...points.map((p) => p[0])) + pad * 2;
  let y0 = Math.min(...points.map((p) => p[1])) - pad * 2;
  let y1 = Math.max(...points.map((p) => p[1])) + pad;
  if (keep) [x0, x1, y0, y1] = [Math.min(x0, keep.x), Math.max(x1, keep.x + keep.w), Math.min(y0, keep.y), Math.max(y1, keep.y + keep.h)];
  let w = Math.max(x1 - x0, 240);
  let h = Math.max(y1 - y0, 120);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  if (w / h < size.w / size.h) w = (h * size.w) / size.h;
  else h = (w * size.h) / size.w;
  if (w > MAP_W * 1.1) return WORLD;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function WorldView({ data, selected, onSelect, onDevice }: { data: NetworkPayload; selected?: string; onSelect: (country?: string) => void; onDevice: (id: string) => void }) {
  const watched = data.meta.mode === "live" || data.meta.mode === "demo";
  const now = useOwnersNow(watched);
  const seen = useSeen(now);
  const home = homeOf(data.model, now);
  const [whole, setWhole] = useState(false);
  /** Where someone zoomed or dragged to; until then the map fits the traffic or the world. */
  const [manual, setManual] = useState<Box>();
  const [drag, setDrag] = useState<{ x: number; y: number; box: Box; moved: boolean }>();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(0, el.clientWidth - SIDE_W), h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const still = useMemo(() => matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  const placed = seen.flatMap((s) => {
    const c = s.place.country ? COUNTRIES[s.place.country] : undefined;
    if (!c) return [];
    const at = project(c[0], c[1]);
    return [{ ...s, code: s.place.country!, at, arc: home ? arc(at, home.at) : undefined }];
  });

  // The view grows to take in every place seen this visit, so it does not jump as places come and go.
  const kept = useRef<{ box: Box; size: typeof size }>(undefined);
  const keep = kept.current?.size === size ? kept.current.box : undefined;
  const auto = whole ? WORLD : fit([...(home ? [home.at] : []), ...placed.map((p) => p.at)], size, keep);
  useEffect(() => {
    if (!whole) kept.current = { box: auto, size };
  });
  const box = manual ?? auto;
  /** Screen pixels per map unit. */
  const k = size.w ? size.w / box.w : 1;
  const px = (n: number) => n / k;

  const max = Math.max(1, ...seen.filter((s) => s.now).map((s) => s.place.downBps + s.place.upBps));
  // Names for the selected place and the busiest ones, as long as they do not run into each other
  // (or into home's): a quieter place's name gives way.
  const labelled = new Set<string>();
  const taken: Box[] = home ? [{ x: home.at[0] - px(20), y: home.at[1] + px(10), w: px(40), h: px(16) }] : [];
  const candidates = [...placed.filter((p) => p.code === selected), ...placed.filter((p) => p.now && p.code !== selected).slice(0, 8)];
  for (const p of candidates) {
    const b = { x: p.at[0] + px(8), y: p.at[1] - px(8), w: px(countryName(p.code).length * 6.6 + 4), h: px(15) };
    if (taken.some((t) => b.x < t.x + t.w && t.x < b.x + b.w && b.y < t.y + t.h && t.y < b.y + b.h)) continue;
    taken.push(b);
    labelled.add(p.code);
  }
  const sel = seen.find((s) => (s.place.country ?? "-") === selected);

  return (
    <div className="world" ref={ref} style={{ ["--side-w" as string]: `${SIDE_W}px` }}>
      <div
        className={`world-map${drag?.moved ? " drag" : ""}`}
        style={{ right: SIDE_W }}
        onClick={() => (drag?.moved ? undefined : onSelect(undefined))}
        onWheel={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // The point under the pointer stays where it is.
          const fx = (e.clientX - r.left) / r.width;
          const fy = (e.clientY - r.top) / r.height;
          const f = Math.exp(e.deltaY * 0.0015);
          const w = Math.min(MAP_W * 1.2, Math.max(60, box.w * f));
          const h = (w * box.h) / box.w;
          setManual({ x: box.x + fx * (box.w - w), y: box.y + fy * (box.h - h), w, h });
        }}
        onPointerDown={(e) => e.button === 0 && setDrag({ x: e.clientX, y: e.clientY, box, moved: false })}
        onPointerMove={(e) => {
          if (!drag) return;
          const dx = e.clientX - drag.x;
          const dy = e.clientY - drag.y;
          if (!drag.moved && Math.hypot(dx, dy) < 4) return;
          if (!drag.moved) e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ ...drag, moved: true });
          setManual({ ...drag.box, x: drag.box.x - dx / k, y: drag.box.y - dy / k });
        }}
        onPointerUp={() => setTimeout(() => setDrag(undefined))}
      >
        <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet">
          <path d={LAND} className="land" />
          {placed.map((p) => {
            const dim = selected && selected !== p.code;
            const busy = level(p.place.downBps + p.place.upBps);
            const r = px(p.now ? 3 + 5 * busy : 2.5);
            return (
              <g key={p.code} className={`place${dim ? " dim" : ""}${p.now ? "" : " earlier"}`} onClick={(e) => (e.stopPropagation(), drag?.moved || onSelect(p.code))}>
                <title>{`${countryName(p.code)}: ${p.now ? `↓ ${fmtBps(p.place.downBps)} ↑ ${fmtBps(p.place.upBps)}` : "nothing in the latest read"}`}</title>
                {p.arc && (
                  <>
                    <path id={`arc-${p.code}`} d={p.arc.d} className="arc" strokeWidth={p.now ? 1 + 1.5 * busy : 1} />
                    {p.now && !still && <Flow pathId={`arc-${p.code}`} len={p.arc.len * k} down={p.place.downBps} up={p.place.upBps} color="var(--chart-up)" size={px(1)} />}
                  </>
                )}
                <circle cx={p.at[0]} cy={p.at[1]} r={r} className="dot" />
                <circle cx={p.at[0]} cy={p.at[1]} r={px(14)} className="hit" />
                {selected === p.code && <circle cx={p.at[0]} cy={p.at[1]} r={r + px(5)} className="ring" />}
                {labelled.has(p.code) && (
                  <text x={p.at[0] + r + px(5)} y={p.at[1] + px(4)} fontSize={px(11.5)} className="lab">
                    {countryName(p.code)}
                  </text>
                )}
              </g>
            );
          })}
          {home && (
            <g className="home">
              <title>{`Home. ${home.why}`}</title>
              <circle cx={home.at[0]} cy={home.at[1]} r={px(9)} className="home-ring" />
              <circle cx={home.at[0]} cy={home.at[1]} r={px(3.5)} className="home-dot" />
              <text x={home.at[0]} y={home.at[1] + px(23)} fontSize={px(11.5)} textAnchor="middle" className="lab home-lab">
                Home
              </text>
            </g>
          )}
        </svg>
        <div className="world-ctl" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <div className="seg">
            <button className={whole || manual ? undefined : "on"} onClick={() => (setWhole(false), setManual(undefined))}>Where it goes</button>
            <button className={whole && !manual ? "on" : undefined} onClick={() => (setWhole(true), setManual(undefined))}>Whole world</button>
          </div>
        </div>
        <div className="legend world-legend">
          <span className="legend-note">
            Plain dots come home (download), orange ones go out (upload): more and faster dots, more traffic. Faint places carried something in the last two minutes, not now.
          </span>
          <span className="legend-note">
            {home ? `Home is ${home.why}` : "Home is not on the map: the router reports no time zone and no public address to place it by."} Countries are a guess from a geolocation database: it names one country per address
            range, and big services answer from many places.{" "}
            {now && (
              <a href={now.placesCredit.url} target="_blank" rel="noreferrer noopener">
                {now.placesCredit.text}
              </a>
            )}
          </span>
        </div>
      </div>

      <aside className="side world-side">
        <div>
          <h2>Where the traffic goes</h2>
          <p className="faint">The router's connection table, read every few seconds, by the country of each address on the other end.</p>
        </div>
        {!watched ? (
          <p className="faint">Needs a router to read: sign in to one, or open the demo.</p>
        ) : !now || !now.seconds ? (
          <span className="faint pulse">Measuring…</span>
        ) : (
          <>
            {!now.placesKnown && <p className="faint">Countries arrive once Stribog has its country database, a 5 MB download from DB-IP, kept in the data directory.</p>}
            {!seen.length ? (
              <span className="faint">Quiet: nothing going to the internet.</span>
            ) : (
              <div className="wl">
                {seen.map((s) => {
                  const code = s.place.country ?? "-";
                  const total = s.place.downBps + s.place.upBps;
                  return (
                    <button key={code} className={`wl-row${selected === code ? " on" : ""}${s.now ? "" : " earlier"}`} onClick={() => onSelect(selected === code ? undefined : code)}>
                      <b>{countryName(s.place.country)}</b>
                      <span className="ob-bar">{s.now && <i style={{ width: `${Math.max(2, (total / max) * 100)}%` }} />}</span>
                      {s.now ? (
                        <>
                          <span className="ob-rate">{fmtBps(s.place.downBps)}<i> ↓</i></span>
                          <span className="ob-rate up">{fmtBps(s.place.upBps)}<i> ↑</i></span>
                        </>
                      ) : (
                        <span className="wl-ago">{ago(now.at - s.at)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
        {sel && <Details s={sel} onDevice={onDevice} />}
      </aside>
    </div>
  );
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : `${Math.round(ms / 60_000)} min ago`);

function Details({ s, onDevice }: { s: Seen; onDevice: (id: string) => void }) {
  const p = s.place;
  return (
    <div className="world-details">
      <div className="sec-title">
        {countryName(p.country)}
        <em className="faint">{s.now ? `${p.connections} connection${p.connections === 1 ? "" : "s"}` : "earlier"}</em>
      </div>
      {!p.country && <p className="faint">Addresses the country database does not know, or Stribog does not have it yet.</p>}
      <div className="kv">
        <span>Who runs them</span>
        <span className="tx">
          {p.owners.map((o) => (
            <div key={o.name}>
              {o.name} <span className="faint">{fmtBps(o.bps)}</span>
            </div>
          ))}
        </span>
        <span>From here</span>
        <span className="tx">
          {p.devices.map((d) => (
            <div key={d.id}>
              <a href="#" onClick={(e) => (e.preventDefault(), onDevice(d.id))}>{d.name}</a> <span className="faint">{fmtBps(d.bps)}</span>
            </div>
          ))}
        </span>
      </div>
      {!s.now && <p className="faint">Rates as they were {ago(Date.now() - s.at)}.</p>}
    </div>
  );
}
