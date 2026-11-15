import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { isOpen } from "../../core/analyze.ts";
import type { Device, Finding, NetworkPayload, Radio, Severity } from "../api.ts";
import type { Band } from "../../core/net.ts";
import { connectionViews } from "../../core/model.ts";
import { FindingCard } from "../components/FindingCard.tsx";
import { Glyph, bandColor } from "../components/DeviceArt.tsx";
import { WifiNetworkForm } from "../components/WifiNetworkForm.tsx";
import {
  AXIS,
  BAND_LABEL,
  blockSpan,
  planBlocks,
  planChannels,
  planMaxWidth,
  radioBlock,
  securityLabel,
  signalWord,
  SIGNAL_ZONES,
  type Block,
} from "./spectrum.ts";
import "./wifi.css";

const BANDS: Band[] = ["2.4", "5", "6"];
const SEV_ORDER: Severity[] = ["critical", "warning", "suggestion", "info", "pass"];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const minus = (n: number) => String(n).replace("-", "\u2212");
const countWord = (n: number) => ["no", "one", "two", "three", "four"][n] ?? String(n);

/** Width of an element, kept current. Charts draw in real pixels so text stays crisp. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export type WifiTab = "overview" | "setup" | "review";
const TABS: { id: WifiTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "setup", label: "Setup" },
  { id: "review", label: "Review" },
];

export function WifiView({ data, tab, focus, onTab, onSelect }: { data: NetworkPayload; tab: WifiTab; focus?: string; onTab: (t: WifiTab) => void; onSelect: (id: string) => void }) {
  // A finding linked from elsewhere opens, in view.
  useLayoutEffect(() => {
    if (tab === "review" && focus) document.getElementById(`f-${focus}`)?.scrollIntoView({ block: "center" });
  }, [tab, focus]);
  const { model, analysis } = data;
  const aps = model.devices.filter((d) => d.kind === "ap" || model.radios.some((r) => r.apId === d.id));
  const clients = connectionViews(model.devices).filter((d) => d.via?.kind === "wifi" && d.status !== "offline");
  const apName = (id: string) => model.devices.find((d) => d.id === id)?.name ?? id;
  const devName = (id: string) => model.devices.find((d) => d.id === id)?.name ?? id;

  const wifiFindings = analysis.findings.filter((f) => f.category === "wifi");
  const open = wifiFindings.filter(isOpen).sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const good = wifiFindings.filter((f) => f.severity === "pass");
  const bands = BANDS.filter((b) => model.radios.some((r) => r.band === b));
  const onShow = (f: Finding) => f.devices?.[0] && onSelect(f.devices[0]);

  return (
    <div className="scroll">
      <div className="page">
        <h1>Wi-Fi</h1>
        <div className="tabs" role="tablist" aria-label="Wi-Fi">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : undefined} onClick={() => onTab(t.id)}>
              {t.label}
              {t.id === "review" && open.length > 0 && <span className="tab-count">{open.length}</span>}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <>
            <p className="lede">
              {model.ssids.length || model.radios.length ? (
                <>
                  {plural(model.ssids.length, "network name")} on {plural(aps.length, "access point")}, with {plural(clients.length, "device")} connected.
                </>
              ) : (
                "No Wi-Fi radios were found in the configuration."
              )}
            </p>

            {model.ssids.length > 0 && (
              <>
                <div className="sec-title">Network names <em className="faint">what devices see when they search for Wi-Fi</em></div>
                <div className="wf-ssids">
                  {model.ssids.map((s) => {
                    const net = model.networks.find((n) => n.id === s.network);
                    const wpa3 = s.auth.some((a) => a.startsWith("wpa3"));
                    const wpa2 = s.auth.some((a) => a.startsWith("wpa2"));
                    return (
                      <div key={s.name} className="card wf-ssid">
                        <div className="wf-ssid-head">
                          <WifiMark />
                          <b>{s.name}</b>
                          {s.hidden && <span className="cert" title="The name is not broadcast; devices must be told it.">hidden</span>}
                          <span className="wf-grow" />
                          {s.bands.map((b) => <span key={b} className={`chip band-${b}`}>{BAND_LABEL[b]}</span>)}
                        </div>
                        <div className="kv">
                          <span>Security</span>
                          <span className="tx">
                            {securityLabel(s.auth)}
                            <span className="faint wf-hint">{wpa3 && wpa2 ? "newer devices use WPA3, older ones WPA2" : wpa3 ? "WPA3 only; very old devices cannot join" : wpa2 ? "solid with a long passphrase" : ""}</span>
                          </span>
                          <span>Fast roaming</span>
                          <span className="tx">
                            {s.ft ? "On" : "Off"}
                            <span className="faint wf-hint">{s.ft ? "802.11r: quick hand-over between APs" : aps.length > 1 ? "802.11r: worth turning on with several APs" : "802.11r: only matters with several APs"}</span>
                          </span>
                          <span>Network</span>
                          <span className="tx">{net ? <>{net.label}{net.cidr && <span className="mono faint" style={{ marginLeft: 8 }}>{net.cidr}</span>}</> : "—"}</span>
                          <span>Broadcast by</span>
                          <span className="tx">{s.aps.length ? s.aps.map(apName).join(", ") : <span className="faint">no access point yet</span>}</span>
                          <span>Devices</span>
                          <span className="tx mono">{s.clients}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <div className="sec-title">Signal <em className="faint">{model.hasState ? "how strongly each device hears its access point" : "needs live data from the router"}</em></div>
            <SignalStrip clients={clients} findings={open} onSelect={onSelect} />

            {aps.length > 0 && (
              <>
                <div className="sec-title">Access points</div>
                <div className="wf-aps">
                  {aps.map((ap) => <ApCard key={ap.id} ap={ap} radios={model.radios.filter((r) => r.apId === ap.id)} onSelect={onSelect} />)}
                </div>
              </>
            )}
          </>
        )}

        {tab === "setup" && (
          <>
            <p className="lede">Names, passwords and security of the Wi-Fi networks, and how the airwaves are shared. Every change waits for you to keep it: if it cuts you off, the router puts the old settings back by itself.</p>
            {model.ssids.length > 0 && (
              <>
                <div className="sec-title">Networks <em className="faint">changed on the router, for every access point it manages</em></div>
                <div className="wf-forms">
                  {model.ssids.map((x, i) => <WifiNetworkForm key={i} s={x} canChange={data.meta.mode !== "files"} />)}
                </div>
              </>
            )}
            {bands.length > 0 ? (
              <>
                <div className="sec-title">Channels <em className="faint">who is using which part of the airwaves</em></div>
                <div style={{ display: "grid", gap: 12 }}>
                  {bands.map((b) => (
                    <Spectrum
                      key={b}
                      band={b}
                      radios={model.radios.filter((r) => r.band === b)}
                      apName={apName}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="card muted">No Wi-Fi radios were found in the configuration.</div>
            )}
          </>
        )}

        {tab === "review" && (
          <>
            <p className="lede">{open.length ? `${plural(open.length, "thing")} on the Wi-Fi side worth a look. Each says why it matters; accept the ones that are fine for you.` : "Nothing on the Wi-Fi side needs attention."}</p>
            <div style={{ display: "grid", gap: 8 }}>
              {open.map((f) => <FindingCard key={f.id} f={f} open={f.id === focus} onShow={f.devices?.length ? onShow : undefined} deviceName={devName} />)}
            </div>
            {good.length > 0 && (
              <details className="wf-good">
                <summary>
                  <span className="dot" />
                  What's good <span className="mono faint">{good.length}</span>
                  <span className="wf-chev">›</span>
                </summary>
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {good.map((f) => <FindingCard key={f.id} f={f} deviceName={devName} />)}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function WifiMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" style={{ color: "var(--tx-2)", flex: "none" }}>
      <path d="M3 9.5a13 13 0 0 1 18 0M6 13a8 8 0 0 1 12 0M9 16.5a3.5 3.5 0 0 1 6 0" />
      <circle cx={12} cy={19.5} r={0.9} fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Channel spectrum

interface Scale {
  /** Left and right edge of a hill for a block. */
  span(b: Block): [number, number];
  ticks: { ch: number; x: number; label: boolean }[];
  /** Horizontal extent of a run of 20 MHz channels. */
  chans(chs: number[]): [number, number];
  breaks: number[];
}

const PAD = 18;

function makeScale(band: Band, W: number): Scale {
  if (band === "2.4") {
    // Continuous: 2.4 GHz channels are 5 MHz apart and a 20 MHz signal covers about five of them.
    const d0 = -1.6;
    const d1 = 15.6;
    const x = (c: number) => PAD + ((c - d0) / (d1 - d0)) * (W - 2 * PAD);
    return {
      span: (b) => {
        const s = b.width >= 40 ? 6.4 : 2.4;
        return [x(b.primary - s), x(b.primary + s)];
      },
      chans: (chs) => [x(Math.min(...chs) - 0.5), x(Math.max(...chs) + 0.5)],
      ticks: AXIS["2.4"].flat().map((ch) => ({ ch, x: x(ch), label: true })),
      breaks: [],
    };
  }
  // Discrete 20 MHz slots in runs, with a small break between runs (5 GHz skips 68–96 in the EU).
  const runs = AXIS[band];
  const GAP = 22;
  const slots = runs.reduce((s, r) => s + r.length, 0);
  const slotW = (W - 2 * PAD - GAP * (runs.length - 1)) / slots;
  const pos = new Map<number, number>();
  const breaks: number[] = [];
  let x = PAD;
  runs.forEach((run, i) => {
    if (i) {
      breaks.push(x + GAP / 2);
      x += GAP;
    }
    for (const ch of run) {
      pos.set(ch, x);
      x += slotW;
    }
  });
  const left = (ch: number) => pos.get(ch) ?? PAD;
  const chans = (chs: number[]): [number, number] => {
    const known = chs.filter((c) => pos.has(c));
    if (!known.length) return [PAD, PAD];
    return [left(Math.min(...known)), left(Math.max(...known)) + slotW];
  };
  const every = slotW < 16 ? 4 : 1;
  return {
    span: (b) => {
      const [a, z] = chans(b.channels);
      return [a + 1.5, z - 1.5];
    },
    chans,
    ticks: [...pos.entries()].map(([ch, px], i) => ({ ch, x: px + slotW / 2, label: i % every === 0 })),
    breaks,
  };
}

/** A soft hill: rounded shoulders for 2.4 GHz, a flatter mesa for bonded 5/6 GHz blocks. */
function hillPath(band: Band, x0: number, x1: number, base: number, top: number): string {
  const w = x1 - x0;
  if (band === "2.4") {
    const s = w * 0.22;
    return `M${x0} ${base} C${x0 + s * 0.7} ${base} ${x0 + s * 0.55} ${top} ${x0 + s * 1.5} ${top} L${x1 - s * 1.5} ${top} C${x1 - s * 0.55} ${top} ${x1 - s * 0.7} ${base} ${x1} ${base} Z`;
  }
  const s = Math.min(14, w * 0.25);
  return `M${x0} ${base} C${x0 + s * 0.6} ${base} ${x0 + s * 0.25} ${top} ${x0 + s} ${top} L${x1 - s} ${top} C${x1 - s * 0.25} ${top} ${x1 - s * 0.6} ${base} ${x1} ${base} Z`;
}

interface Item {
  key: string;
  name: string;
  sub: string;
  x0: number;
  x1: number;
  block: Block;
}

function Spectrum({ band, radios, apName }: { band: Band; radios: Radio[]; apName: (id: string) => string }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const color = bandColor(band);
  const plan = planChannels(radios);
  const width = Math.max(...radios.map(planMaxWidth));
  const blocks = planBlocks(band, plan, width);
  const skipDfs = radios.some((r) => r.plan?.skipDfs);
  const unknown = radios.filter((r) => !r.current);
  const id = `b${band.replace(".", "")}`;

  const scale = W ? makeScale(band, W) : undefined;
  const items: Item[] = [];
  if (scale) {
    for (const r of radios) {
      const b = radioBlock(r);
      if (!b) continue;
      const [x0, x1] = scale.span(b);
      items.push({ key: r.id, name: apName(r.apId), sub: `ch ${b.primary} · ${b.width} MHz`, x0, x1, block: b });
    }
  }

  // Labels sit above their hill; overlapping labels move up a lane.
  const lanes: [number, number][][] = [];
  const laneOf = new Map<string, number>();
  const labelW = (it: Item) => Math.max(it.name.length * 7, it.sub.length * 6.8) + 16;
  const fits = (lane: [number, number][], l: number, r: number) => lane.every(([a, z]) => r + 10 < a || l > z + 10);
  const ordered = [...items].sort((a, b) => a.x0 - b.x0);
  for (const it of ordered) {
    const c = (it.x0 + it.x1) / 2;
    const lw = labelW(it);
    const [l, r] = [c - lw / 2, c + lw / 2];
    let lane = lanes.findIndex((ln) => fits(ln, l, r));
    if (lane < 0) lane = lanes.push([]) - 1;
    lanes[lane]!.push([l, r]);
    laneOf.set(it.key, lane);
  }
  const nLanes = Math.max(1, lanes.length);
  const LANE = 38;
  const top = 6 + nLanes * LANE;
  const hillH = 78;
  const base = top + hillH + 10;
  const H = base + 58;

  const dfsRuns = band === "5" ? [[52, 56, 60, 64], AXIS["5"][1]!] : [];
  const planRuns = runsOf(band, plan);

  return (
    <div className="card wf-spec">
      <div className="wf-spec-head">
        <span className={`chip band-${band}`}>{BAND_LABEL[band]}</span>
        <span className="muted">{plural(radios.length, "radio")}{plan.length ? ` · plan allows ${plan.length} channel${plan.length === 1 ? "" : "s"} at up to ${width} MHz` : ""}</span>
        <span className="wf-grow" />
        <span className="wf-legend">
          <span><i className="sw" style={{ background: `color-mix(in srgb, ${color} 45%, transparent)`, borderColor: color }} />in use</span>
          {plan.length > 0 && <span><i className="br" />allowed by plan</span>}
          {band === "5" && <span><i className="sw hatch" />radar (DFS)</span>}
        </span>
      </div>
      <div ref={ref} className="wf-spec-plot">
        {scale && (
          <svg width={W} height={H} role="img" aria-label={`${BAND_LABEL[band]} channel map`}>
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity=".42" />
                <stop offset="1" stopColor={color} stopOpacity=".04" />
              </linearGradient>
              <pattern id={`${id}-dfs`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--fg)" strokeOpacity={.07} strokeWidth="2" />
              </pattern>
            </defs>

            {/* Radar (DFS) channels */}
            {dfsRuns.map((run, i) => {
              const [a, z] = scale.chans(run);
              return (
                <g key={i}>
                  <rect x={a} y={top - 4} width={z - a} height={base - top + 4} fill={`url(#${id}-dfs)`} rx={6} />
                  {z - a > 40 && (
                    <text x={a + 8} y={top + 10} className="wf-svg-cap">{z - a > 240 ? `DFS · radar check${skipDfs ? " · skipped by your plan" : ""}` : "DFS"}</text>
                  )}
                </g>
              );
            })}

            {/* Axis */}
            <line x1={PAD} x2={W - PAD} y1={base} y2={base} stroke="var(--fg)" strokeOpacity={.12} />
            {scale.ticks.map((t) => {
              const allowed = plan.includes(t.ch);
              return (
                <g key={t.ch}>
                  <line x1={t.x} x2={t.x} y1={base} y2={base + (allowed ? 5 : 3)} stroke={allowed ? color : "var(--fg)"} strokeOpacity={allowed ? 1 : 0.18} />
                  {t.label && (
                    <text x={t.x} y={base + 17} textAnchor="middle" className={`wf-svg-tick${allowed ? " on" : ""}`} style={allowed ? { fill: color } : undefined}>
                      {t.ch}
                    </text>
                  )}
                </g>
              );
            })}
            {scale.breaks.map((bx) => (
              <g key={bx} stroke="var(--fg)" strokeOpacity={.22} strokeWidth={1.2}>
                <line x1={bx - 5} y1={base + 4} x2={bx - 1} y2={base - 4} />
                <line x1={bx + 1} y1={base + 4} x2={bx + 5} y2={base - 4} />
              </g>
            ))}

            {/* Channel plan brackets */}
            {planRuns.map((run, i) => {
              const [a, z] = scale.chans(run);
              const y = base + 28;
              return (
                <g key={i}>
                  <path d={`M${a + 2} ${y - 4} V${y} H${z - 2} V${y - 4}`} fill="none" stroke={color} strokeOpacity=".55" />
                  {i === 0 && <text x={a + 2} y={y + 15} className="wf-svg-cap">{band === "2.4" ? "allowed channels" : `allowed by your channel plan${blocks.length ? ` · ${countWord(blocks.length)} ${width} MHz block${blocks.length === 1 ? "" : "s"}` : ""}`}</text>}
                </g>
              );
            })}

            {/* Hills */}
            {items.map((it) => (
              <g key={it.key}>
                <path d={hillPath(band, it.x0, it.x1, base, top + 8)} fill={`url(#${id}-fill)`} />
                <path d={hillPath(band, it.x0, it.x1, base, top + 8)} fill="none" stroke={color} strokeWidth={1.5} strokeOpacity=".9" />
                {band !== "2.4" && it.block.channels.length > 1 && (
                  <text x={(it.x0 + it.x1) / 2} y={base - 8} textAnchor="middle" className="wf-svg-span">{blockSpan(it.block)}</text>
                )}
              </g>
            ))}
            {/* Labels */}
            {items.map((it) => {
              const hillTop = top + 8;
              const subStyle = { fill: color };
              const c = Math.min(Math.max((it.x0 + it.x1) / 2, 70), W - 70);
              const lane = laneOf.get(it.key) ?? 0;
              const y = top - 8 - lane * LANE;
              return (
                <g key={it.key}>
                  {lane > 0 && <line x1={c} x2={c} y1={y + 4} y2={hillTop - 2} stroke="var(--fg)" strokeOpacity={.12} strokeDasharray="2 3" />}
                  <text x={c} y={y - 15} textAnchor="middle" className="wf-svg-name">{it.name}</text>
                  <text x={c} y={y} textAnchor="middle" className="wf-svg-sub" style={subStyle}>{it.sub}</text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className="wf-spec-notes">
        <p className="muted">{bandCaption(band, blocks, width, skipDfs)}</p>
        {unknown.map((r) => (
          <p key={r.id} className="faint">{apName(r.apId)} ({r.iface}) has not reported its current channel, so it is not drawn.</p>
        ))}
      </div>
    </div>
  );
}

function bandCaption(band: Band, blocks: Block[], width: number, skipDfs: boolean): string {
  if (band === "2.4")
    return "A 2.4 GHz signal spreads over about five channel numbers, so only 1, 6 and 11 sit side by side without overlapping. It reaches further than 5 GHz but is slower and shared with every neighbour.";
  if (band === "6") return "6 GHz has room for many wide blocks, but only newer Wi-Fi 6E and Wi-Fi 7 devices can use it, and it reaches less far than 5 GHz.";
  const spans = blocks.map(blockSpan).join(", ");
  const n = blocks.length;
  return `5 GHz is the fast band. Neighbouring 20 MHz channels bond into wider blocks (40 MHz uses two, 80 MHz uses four): wider is faster, but leaves fewer blocks to share between access points.${
    n ? ` Your plan leaves ${countWord(n)} ${width} MHz block${n === 1 ? "" : "s"} (${spans})${skipDfs ? " because it skips the radar-checked DFS channels" : ""}.` : ""
  }`;
}

/** Contiguous runs of the channel plan's channels, so the plan bracket does not span gaps. */
function runsOf(band: Band, chs: number[]): number[][] {
  const step = band === "2.4" ? 1 : 4;
  const out: number[][] = [];
  for (const c of [...chs].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && c - last.at(-1)! === step && !(band === "5" && isGap(last.at(-1)!, c))) last.push(c);
    else out.push([c]);
  }
  return out;
}
const isGap = (a: number, b: number) => (a <= 64 && b >= 100) || (a <= 144 && b >= 149);

// ---------------------------------------------------------------------------
// Signal strip

const S_MIN = -92;
const S_MAX = -28;

function SignalStrip({ clients, findings, onSelect }: { clients: Device[]; findings: Finding[]; onSelect: (id: string) => void }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const withSignal = clients.filter((d) => d.via?.signal !== undefined);
  const bands = BANDS.filter((b) => withSignal.some((d) => d.via?.band === b));
  const x = (s: number) => ((Math.min(S_MAX, Math.max(S_MIN, s)) - S_MIN) / (S_MAX - S_MIN)) * W;
  const pct = (s: number) => `${((Math.min(S_MAX, Math.max(S_MIN, s)) - S_MIN) / (S_MAX - S_MIN)) * 100}%`;

  if (!withSignal.length)
    return <div className="card muted">{clients.length ? "Connected devices have not reported their signal strength." : "No devices are connected over Wi-Fi right now."}</div>;

  // What the review says about these devices: one link each, not the same text twice.
  const notes = withSignal.flatMap((d) => {
    const f = findings.find((x) => x.devices?.includes(d.id));
    return f ? [{ d, f }] : [];
  });
  const ticks = [-90, -80, -70, -60, -50, -40];

  return (
    <div className="card wf-sig">
      <div className="wf-sig-grid">
        <span />
        <div ref={ref} className="wf-sig-zones">
          {SIGNAL_ZONES.map((z) => (
            <span key={z.label} style={{ left: pct(z.from), width: `calc(${pct(z.to)} - ${pct(z.from)})`, color: z.tint }}>{z.label}</span>
          ))}
        </div>
        {bands.map((b) => {
          const list = withSignal.filter((d) => d.via?.band === b).sort((a, c) => a.via!.signal! - c.via!.signal!);
          // Pills stack upward when they would collide.
          const lanes: number[] = [];
          const placed = list.map((d) => {
            const px = W ? x(d.via!.signal!) : 0;
            const w = 58 + d.name.length * 6.8 + (d.only24 && b === "2.4" ? 52 : 0);
            let left = px - 13;
            if (W && left + w > W) left = W - w;
            let lane = lanes.findIndex((r) => left > r + 6);
            if (lane < 0) lane = lanes.push(0) - 1;
            lanes[lane] = left + w;
            return { d, px, left, lane };
          });
          const h = Math.max(1, lanes.length) * 34 + 20;
          return (
            <Row key={b} band={b} count={list.length}>
              <div className="wf-sig-track" style={{ height: h }}>
                {SIGNAL_ZONES.map((z) => (
                  <i key={z.label} className="wf-zone" style={{ left: pct(z.from), width: `calc(${pct(z.to)} - ${pct(z.from)})`, background: `color-mix(in srgb, ${z.tint} 5%, transparent)` }} />
                ))}
                {W > 0 &&
                  placed.map(({ d, px, left, lane }) => {
                    const y = h - 14 - lane * 34 - 26;
                    return (
                      <div key={d.id}>
                        <i className="wf-stem" style={{ left: px, top: y + 26, height: h - 10 - (y + 26) }} />
                        <i className="wf-dot" style={{ left: px, background: bandColor(b) }} />
                        <button className="wf-pill" style={{ left, top: y }} onClick={() => onSelect(d.id)} title={`${d.name}: ${d.via!.signal} dBm (${signalWord(d.via!.signal)})${d.via?.ssid ? ` on ${d.via.ssid}` : ""}`}>
                          <Glyph kind={d.kind} size={15} color={bandColor(b)} />
                          <span className="nm">{d.name}</span>
                          {d.only24 && b === "2.4" && <span className="wf-only">2.4 only</span>}
                          <span className="mono db">{minus(d.via!.signal!)}</span>
                        </button>
                      </div>
                    );
                  })}
              </div>
            </Row>
          );
        })}
        <span />
        <div className="wf-sig-ticks">
          {ticks.map((t) => <span key={t} className="mono" style={{ left: pct(t) }}>{minus(t)}</span>)}
          <span className="unit">dBm</span>
        </div>
      </div>
      <p className="faint wf-sig-help">
        Signal is measured in dBm: a negative number where closer to zero is stronger. Every 3 dB is double or half the power, so −70 is a quarter of −64. Click a device to see it on the map.
      </p>
      {notes.length > 0 && (
        <p className="wf-sig-more">
          In the review:{" "}
          {notes.map(({ d, f }, i) => (
            <span key={d.id}>
              {i > 0 && " · "}
              <a href={`#/wifi?t=review&f=${encodeURIComponent(f.id)}`} title={f.title}>{d.name}</a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function Row({ band, count, children }: { band: Band; count: number; children: ReactNode }) {
  return (
    <>
      <div className="wf-sig-band">
        <span className={`chip band-${band}`}>{BAND_LABEL[band]}</span>
        <span className="faint" style={{ fontSize: 11.5 }}>{plural(count, "device")}</span>
      </div>
      {children}
    </>
  );
}

// ---------------------------------------------------------------------------
// Access points

function ApCard({ ap, radios, onSelect }: { ap: Device; radios: Radio[]; onSelect: (id: string) => void }) {
  const clients = radios.reduce((s, r) => s + r.clients, 0);
  return (
    <div className="card wf-ap">
      <button className="wf-ap-head" onClick={() => onSelect(ap.id)}>
        <span className="wf-ap-ic"><Glyph kind="ap" size={20} /></span>
        <div>
          <b>{ap.name}</b>
          <div className="faint" style={{ fontSize: 12 }}>
            {[ap.model, ap.ip].filter(Boolean).map((v, i) => <span key={i} className={i ? "mono" : undefined}>{i ? " · " : ""}{v}</span>)}
          </div>
        </div>
        <span className="wf-grow" />
        <span className="muted" style={{ display: "inline-flex", gap: 7, alignItems: "center", fontSize: 12 }}>
          <span className={`dot${ap.status === "online" ? "" : ap.status === "offline" ? " bad" : " off"}`} />
          {ap.status === "online" ? `${plural(clients, "device")}` : ap.status}
        </span>
      </button>
      {radios.length ? (
        <div className="wf-radios">
          {radios.map((r) => (
            <div key={r.id} className="wf-radio">
              <span className={`chip band-${r.band}`}>{BAND_LABEL[r.band]}</span>
              <span className="mono tx">{r.current ? `ch ${r.current.channel} · ${r.current.width} MHz` : "channel unknown"}</span>
              {r.band === "5" && r.current && (
                <span className="chip" title={r.current.dfs ? "Radar-checked channel: may go quiet for about a minute if radar is detected." : "No radar checks needed on this channel."}>
                  {r.current.dfs ? "DFS" : "non-DFS"}
                </span>
              )}
              <span className="wf-grow" />
              <span className="faint" style={{ fontSize: 12 }}>
                <span className="mono" style={{ color: "var(--tx-2)" }}>{r.clients}</span> {r.clients === 1 ? "device" : "devices"}
              </span>
              <div className="wf-radio-ssids faint">{r.ssids.join(" · ") || "no SSIDs"} <span className="mono">· {r.iface}</span></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="faint">No radios reported for this access point.</div>
      )}
      {ap.via?.port && <div className="faint" style={{ fontSize: 12 }}>Wired to <span className="mono">{ap.via.port}</span>{ap.facts.find((f) => f.startsWith("Powered over PoE")) ? ", powered over PoE" : ""}</div>}
    </div>
  );
}

