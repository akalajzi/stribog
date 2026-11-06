import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from "react";
import type { Device, LNode, NetworkPayload, Severity } from "../api.ts";
import { GATEWAY_W, UPSTREAM_GROUP } from "../../core/layout.ts";
import { fmtBps } from "../../core/net.ts";
import { connectionViews } from "../../core/model.ts";
import { ArtDefs, COLORS, DeviceArt, GatewayArt, mediumColor } from "./DeviceArt.tsx";

const SEV_COLOR: Partial<Record<Severity, string>> = { critical: COLORS.bad, warning: COLORS.warn, suggestion: "var(--idea)" };
const SEV_RANK: Severity[] = ["critical", "warning", "suggestion", "info", "pass"];

interface Props {
  data: NetworkPayload;
  selected?: string;
  highlight?: string[];
  onSelect: (id?: string) => void;
  /** Pixels on the right covered by a panel drawn over the map. */
  covered?: number;
}

type View = { x: number; y: number; w: number; h: number };

export function Topology({ data, selected, highlight, onSelect, covered = 0 }: Props) {
  const { layout, model, analysis } = data;
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>();
  const [drag, setDrag] = useState<{ x: number; y: number; v: View; moved: boolean }>();
  const byId = useMemo(() => new Map(model.devices.map((d) => [d.id, d])), [model]);

  const worst = useMemo(() => {
    const m = new Map<string, Severity>();
    for (const f of analysis.findings) {
      if (f.severity === "pass" || f.severity === "info") continue;
      for (const id of f.devices ?? []) {
        const cur = m.get(id);
        if (!cur || SEV_RANK.indexOf(f.severity) < SEV_RANK.indexOf(cur)) m.set(id, f.severity);
      }
    }
    return m;
  }, [analysis]);

  const fit = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.clientWidth / Math.max(1, el.clientHeight);
    const b = layout.bounds;
    if (b.w / b.h > r) setView({ x: b.x, w: b.w, h: b.w / r, y: b.y - (b.w / r - b.h) / 2 });
    else setView({ y: b.y, h: b.h, w: b.h * r, x: b.x - (b.h * r - b.w) / 2 });
  };
  useEffect(() => {
    fit();
    const ro = new ResizeObserver(fit);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // A panel opened over the map must not hide what was clicked: slide the map just enough,
  // smoothly, and never zoom it.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const n = selected ? layout.nodes.find((x) => x.id === selected) : undefined;
    const el = ref.current;
    const v = viewRef.current;
    if (!n || !el || !covered || !v) return;
    const px = el.clientWidth / v.w;
    const edge = el.clientWidth - covered - 120; // room for the node and its label
    const sx = (n.x - v.x) * px;
    if (sx <= edge) return;
    const from = v.x;
    const to = v.x + (sx - edge) / px;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 260);
      const e = 1 - (1 - k) ** 3;
      setView((cur) => (cur ? { ...cur, x: from + (to - from) * e } : cur));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [selected, covered, layout]);

  const toWorld = (cx: number, cy: number, v: View) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: v.x + ((cx - r.left) / r.width) * v.w, y: v.y + ((cy - r.top) / r.height) * v.h };
  };
  const zoom = (f: number, cx?: number, cy?: number) =>
    setView((v) => {
      if (!v || !ref.current) return v;
      const r = ref.current.getBoundingClientRect();
      const p = toWorld(cx ?? r.left + r.width / 2, cy ?? r.top + r.height / 2, v);
      const w = Math.min(Math.max(v.w * f, 300), layout.bounds.w * 4);
      const k = w / v.w;
      return { x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k, w, h: v.h * k };
    });
  const onWheel = (e: RWheelEvent) => zoom(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY);
  const onDown = (e: RPointerEvent) => view && setDrag({ x: e.clientX, y: e.clientY, v: view, moved: false });
  const onMove = (e: RPointerEvent) => {
    if (!drag || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const dx = ((e.clientX - drag.x) / r.width) * drag.v.w;
    const dy = ((e.clientY - drag.y) / r.height) * drag.v.h;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) setDrag({ ...drag, moved: true });
    setView({ ...drag.v, x: drag.v.x - dx, y: drag.v.y - dy });
  };
  const onUp = () => setTimeout(() => setDrag(undefined), 0);

  const hl = new Set(highlight ?? []);
  const dim = (id: string) => hl.size > 0 && !hl.has(id);
  const router = model.routerId ? byId.get(model.routerId) : undefined;
  const lan = model.networks.find((n) => n.role === "lan");

  const click = (id: string) => () => {
    if (!drag?.moved) onSelect(id === selected ? undefined : id);
  };

  return (
    <div
      ref={ref}
      className={`mapcanvas${drag?.moved ? " drag" : ""}`}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).tagName === "svg") if (!drag?.moved) onSelect(undefined);
      }}
    >
      <div className="gridbg" />
      {view && (
        <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} fontFamily="Inter, SF Pro Text, -apple-system, sans-serif">
          <ArtDefs />

          {layout.zones.map((z, i) => (
            <g key={i}>
              <rect x={z.x} y={z.y} width={z.w} height={z.h} rx={22} fill="var(--up)" fillOpacity={0.018} stroke="var(--up)" strokeOpacity={0.16} strokeDasharray="3 6" />
              <text x={z.x + 20} y={z.y + 28} fill="var(--tx-2)" fontSize={11} fontWeight={600} letterSpacing={1.2}>{z.title.toUpperCase()}</text>
              {z.sub && <text x={z.x + 20} y={z.y + 45} fill="var(--tx-3)" fontSize={11} fontFamily="JetBrains Mono, monospace">{z.sub}</text>}
            </g>
          ))}

          {layout.buses.map((b) => {
            const c = mediumColor(b.medium);
            const wifi = b.medium.startsWith("wifi");
            return (
              <g key={b.id} opacity={dim(b.from) ? 0.25 : 1}>
                <path d={b.d} fill="none" stroke={c} strokeWidth={wifi ? 2.2 : 2.8} strokeOpacity={0.95} strokeDasharray={wifi ? "8 6" : undefined} strokeLinejoin="round" strokeLinecap="round" />
                <text x={b.labelAt.x} y={b.labelAt.y} fontSize={11} fontWeight={600} fill={c}>{[b.label, busy(b)].filter(Boolean).join(" · ")}</text>
              </g>
            );
          })}

          {layout.links.map((l) => {
            const c = mediumColor(l.medium);
            // Cable is solid and heavier; Wi-Fi is dashed in its band colour; planned and legacy are dotted.
            const wifi = l.medium.startsWith("wifi");
            const dashed = l.medium === "planned" ? "2 6" : l.medium === "legacy" ? "2 5" : wifi ? "7 6" : undefined;
            const faded = dim(l.to) && dim(l.from);
            const to = byId.get(l.to);
            const width = l.medium === "2.5g" ? 3.4 : l.medium === "wan" ? 2.6 : 2.8;
            const cable = !dashed && l.medium !== "wan";
            return (
              <g key={l.id} opacity={faded ? 0.25 : 1}>
                {cable && <path d={l.d} fill="none" stroke={c} strokeWidth={width + 3} opacity={l.medium === "2.5g" ? 0.5 : 0.28} filter="url(#soft)" />}
                <path id={l.id} d={l.d} fill="none" stroke={c} strokeOpacity={l.medium === "wan" ? 0.5 : wifi ? (to?.status === "online" ? 0.95 : 0.45) : 1} strokeWidth={wifi ? 2.2 : dashed ? 1.6 : width} strokeDasharray={wifi ? "8 6" : dashed} strokeLinecap="round" />
                {l.route && <path id={`${l.id}:route`} d={l.route} fill="none" stroke="none" />}
                <Flow pathId={l.route ? `${l.id}:route` : l.id} len={l.len} down={l.down} up={l.up} color={c} />
                {(l.label || busy(l)) && l.labelAt && (
                  // Port and speed on the first line, traffic now under it, so neighbours stay apart.
                  <text x={l.labelAt.x} y={l.labelAt.y} textAnchor={l.labelAt.anchor} fontSize={10.5} fontFamily="JetBrains Mono, monospace" fill={c} fillOpacity={l.medium === "wan" || l.medium === "legacy" ? 0.6 : 0.85}>
                    {l.label && <tspan>{l.label}</tspan>}
                    {busy(l) && <tspan x={l.labelAt.x} dy={l.label ? 13 : 0}>{busy(l)}</tspan>}
                  </text>
                )}
              </g>
            );
          })}

          {layout.nodes.map((n) => {
            const d = byId.get(n.id);
            const isSel = selected === n.id;
            const sev = worst.get(n.id);
            if (n.ghost) {
              const p = model.planned.find((x) => `planned:${x.id}` === n.id);
              return (
                <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="node" onClick={click(n.id)} opacity={dim(n.id) ? 0.3 : 1}>
                  <rect className="hit" x={-60} y={-40} width={120} height={110} />
                  <DeviceArt kind={n.kind} ghost />
                  <text y={50} textAnchor="middle" fill={COLORS.w5} fontSize={12.5} fontWeight={600} className="lab-name">{p?.name}</text>
                  <text y={66} textAnchor="middle" fill="var(--tx-2)" fontSize={10.5}>Planned · not applied</text>
                </g>
              );
            }
            if (n.id === UPSTREAM_GROUP) {
              const all = model.devices.filter((x) => x.zone === "upstream" && x.id !== "upstream" && x.mac && x.parent !== model.routerId);
              const now = all.filter((x) => x.status === "online").length;
              return (
                <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="node" onClick={click(n.id)} opacity={dim(n.id) ? 0.3 : 1}>
                  <rect className="hit" x={-70} y={-42} width={140} height={130} />
                  {isSel && <SelectRing r={46} />}
                  {[10, 0, -10].map((o, i) => (
                    <rect key={o} x={-20 + o} y={-20 - o} width={40} height={40} rx={9} fill="var(--ink-2)" stroke="var(--legacy)" strokeOpacity={0.35 + i * 0.2} strokeDasharray="3 3" />
                  ))}
                  <text x={10} y={-5} textAnchor="middle" dominantBaseline="middle" fill="var(--tx-1)" fontSize={14} fontWeight={600} className="mono">{all.length}</text>
                  <Labels n={n} name={`${all.length === 1 ? "1 device" : `${all.length} devices`} seen there`} lines={["", now ? `${now} answering now` : "none answering now"]} />
                </g>
              );
            }
            if (!d) return null;

            const art =
              n.kind === "router" && n.id === model.routerId ? (
                <GatewayArt ports={model.ports} portX={Object.fromEntries(Object.entries(layout.portX).map(([k, v]) => [k, v - n.x]))} model={d.model} />
              ) : (
                <DeviceArt kind={n.kind} status={d.status} accent={d.via?.kind === "port" && model.ports.find((p) => p.name === d.via?.port)?.speedMbps === 2500 ? COLORS.mg : COLORS.g1} />
              );
            const lines = nodeLines(d, data);
            return (
              <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="node" onClick={click(n.id)} opacity={dim(n.id) ? 0.3 : 1}>
                {n.kind === "ap" && <rect x={-22} y={-28} width={44} height={56} rx={11} fill={COLORS.w5} opacity={0.3} filter="url(#glow)" />}
                {isSel && <SelectRing r={n.kind === "router" ? 0 : n.kind === "ap" ? 48 : 46} wide={n.kind === "router"} />}
                <rect className="hit" x={n.kind === "router" ? -GATEWAY_W / 2 - 150 : -70} y={-42} width={n.kind === "router" ? GATEWAY_W + 160 : 140} height={n.label === "below" ? 130 : 86} />
                {art}
                <Labels n={n} name={d.name} lines={lines} sev={sev} />
                {d.services?.length ? <ServicePills n={n} services={d.services} /> : null}
              </g>
            );
          })}

          {router && lan && <title>{lan.label}</title>}
        </svg>
      )}

      <div className="legend">
        <div className="legend-keys">
          <span><i style={{ borderColor: COLORS.mg }} />2.5G</span>
          <span><i style={{ borderColor: COLORS.g1 }} />1G</span>
          <span><i style={{ borderColor: COLORS.w5, borderTopStyle: "dashed" }} />5 GHz Wi-Fi</span>
          <span><i style={{ borderColor: COLORS.w24, borderTopStyle: "dashed" }} />2.4 GHz Wi-Fi</span>
          <span><i style={{ borderColor: COLORS.up, opacity: 0.6 }} />upstream</span>
          <span><i style={{ borderColor: COLORS.tx3, borderTopStyle: "dotted" }} />upstream side</span>
          {model.planned.length > 0 && <span><i style={{ borderColor: COLORS.w5, borderTopStyle: "dotted" }} />planned</span>}
        </div>
        <span className="legend-note">Moving dots are traffic now: light ones go to the device, coloured ones come back</span>
      </div>
      <div className="mapctl">
        <button title="Zoom in" onClick={() => zoom(0.8)}>+</button>
        <button title="Zoom out" onClick={() => zoom(1.25)}>−</button>
        <button title="Fit" onClick={fit} style={{ fontSize: 12 }}>⤢</button>
      </div>
    </div>
  );
}

function SelectRing({ r, wide }: { r: number; wide?: boolean }) {
  if (wide)
    return <rect x={-GATEWAY_W / 2 - 12} y={-44} width={GATEWAY_W + 24} height={92} rx={18} fill="none" stroke="var(--tx-1)" strokeOpacity={0.45} strokeWidth={1.2} />;
  return (
    <g>
      <circle r={r} fill="none" stroke="var(--tx-1)" strokeOpacity={0.5} strokeWidth={1.2} />
      <circle r={r} fill="none" stroke="var(--tx-1)" strokeOpacity={0.25}>
        <animate attributeName="r" values={`${r};${r + 12}`} dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="stroke-opacity" values=".3;0" dur="2.4s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}

/** How busy a link is, 0 (idle, under 2 kb/s) to 1 (1 Gb/s and up), on a log scale. */
const level = (bps?: number) => (!bps || bps < 2000 ? 0 : Math.min(1, (Math.log10(bps) - 3.3) / 5.7));

/** "↓ 48 Mb/s ↑ 2.1 Mb/s" once a link carries at least 1 Mb/s, else nothing. */
function busy(l: { down?: number; up?: number }): string {
  if ((l.down ?? 0) + (l.up ?? 0) < 1e6) return "";
  return [l.down ? `↓ ${fmtBps(l.down)}` : "", l.up ? `↑ ${fmtBps(l.up)}` : ""].filter(Boolean).join(" ");
}

/**
 * Traffic now, as moving dots along the whole way it travels: closer together and faster as
 * throughput grows, none when idle. Speed and spacing are in pixels, so a long route looks as
 * busy as a short one carrying the same traffic. Light dots travel away from the router (down),
 * dots in the link's colour come back (up).
 */
function Flow({ pathId, len, down, up, color }: { pathId: string; len: number; down?: number; up?: number; color: string }) {
  const dots = (bps: number | undefined, back: boolean) => {
    const t = level(bps);
    if (!t) return null;
    const speed = 50 + 250 * t; // px per second
    const gap = 170 - 120 * t; // px between dots
    const dur = Math.max(0.6, len / speed);
    const n = Math.max(1, Math.min(24, Math.round(len / gap)));
    return Array.from({ length: n }, (_, k) => (
      <circle key={`${back}${k}`} r={back ? 2 : 2.4} fill={back ? color : "var(--tx-1)"} opacity={0.9}>
        <animateMotion dur={`${dur.toFixed(2)}s`} begin={`-${((k * dur) / n).toFixed(2)}s`} repeatCount="indefinite" {...(back ? { keyPoints: "1;0", keyTimes: "0;1", calcMode: "linear" } : {})}>
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </circle>
    ));
  };
  return (
    <>
      {dots(down, false)}
      {dots(up, true)}
    </>
  );
}

function nodeLines(d: Device, data: NetworkPayload): string[] {
  const { model } = data;
  const lan = model.networks.find((n) => n.role === "lan");
  switch (d.kind) {
    case "internet":
      return [model.wan.addressKind === "public" ? `${model.wan.address}` : "via ISP", ""];
    case "isp":
      return [d.ip ?? "", d.facts.find((f) => f.startsWith("ISP:"))?.replace("ISP: ", "") ?? ""];
    case model.routerId === d.id ? "router" : "-":
      return [`${d.ip ?? ""} · RouterOS ${d.version ?? "?"}`, `${model.ports.filter((p) => p.deviceIds.length).length} of ${model.ports.length} ports in use`];
    case "ap": {
      const n = connectionViews(model.devices).filter((x) => x.parent === d.id && x.via?.kind === "wifi").length;
      return [`${d.ip ?? ""}`, `${d.model ?? "AP"} · ${n} Wi-Fi client${n === 1 ? "" : "s"}`];
    }
    default: {
      if (d.via?.kind === "wifi") return [d.ip ?? "", [d.via.signal !== undefined ? `${d.via.signal} dBm` : "", d.via.band ? `${d.via.band} GHz` : "", d.via.ssid ?? ""].filter(Boolean).join(" · ")];
      const dns = lan?.dhcp?.dns.includes(d.ip ?? "-") ? "DNS for LAN" : "";
      // A machine's other connections, where they are up: it is drawn once, where its main one is.
      const also = (d.links ?? []).slice(1).filter((l) => l.status === "online").map((l) => (l.via?.kind === "wifi" ? `also Wi-Fi${l.via.band ? ` ${l.via.band} GHz` : ""}` : l.via?.kind === "port" ? `also cable${l.via.port ? ` ${l.via.port}` : ""}` : "also another link"));
      return [d.ip ?? "", [...also, dns, ...(d.labels ?? []).slice(0, 2)].filter(Boolean).slice(0, 2).join(" · ")];
    }
  }
}

/**
 * What runs on a device, from its notes, as small pills under its labels. As many as fit
 * under the label, then "+N"; a pill with a link opens it.
 */
function ServicePills({ n, services }: { n: LNode; services: NonNullable<Device["services"]> }) {
  if (n.label !== "below" && n.label !== "right") return null;
  // About as wide as a name under a device, so neighbours' pills never meet.
  const MAX = n.label === "below" ? 150 : 190;
  const GAP = 4;
  const widthOf = (t: string) => Math.ceil(t.length * 6.1 + 14);
  const shown: { s: (typeof services)[number]; w: number; cut: boolean }[] = [];
  let used = 0;
  for (const [i, s] of services.entries()) {
    const w = widthOf(s.name);
    const rest = services.length - i - 1;
    const more = rest ? widthOf(`+${rest}`) + GAP : 0;
    if (used + w + more > MAX && shown.length) break;
    shown.push({ s, w: Math.min(w, MAX), cut: w > MAX });
    used += w + GAP;
  }
  const hidden = services.length - shown.length;
  const items = [...shown.map((x) => ({ label: x.s.name, w: x.w, cut: x.cut, url: x.s.url, title: [x.s.name, x.s.port ? `port ${x.s.port}${x.s.protocol ? `/${x.s.protocol}` : ""}` : "", x.s.note ?? ""].filter(Boolean).join(" · ") })), ...(hidden ? [{ label: `+${hidden}`, w: widthOf(`+${hidden}`), cut: false, url: undefined, title: services.slice(shown.length).map((s) => s.name).join(", ") }] : [])];
  const total = items.reduce((t, x) => t + x.w, 0) + GAP * (items.length - 1);
  let x = n.label === "below" ? -total / 2 : n.kind === "tv" || n.kind === "iot" ? 40 : 44;
  const y = n.label === "below" ? 95 : 35;
  return (
    <g className="svc-pills">
      {items.map((it, i) => {
        const at = x;
        x += it.w + GAP;
        const pill = (
          <g>
            <title>{it.title}</title>
            <rect x={at} y={y} width={it.w} height={17} rx={8.5} fill="var(--ink-2)" stroke="var(--hair-2)" />
            <text x={at + it.w / 2} y={y + 12} textAnchor="middle" fontSize={10.5} fill={it.url ? "var(--tx-1)" : "var(--tx-2)"}>
              {it.cut ? `${it.label.slice(0, Math.floor((it.w - 20) / 6.1))}…` : it.label}
            </text>
          </g>
        );
        return it.url ? (
          <a key={i} href={it.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
            {pill}
          </a>
        ) : (
          <g key={i}>{pill}</g>
        );
      })}
    </g>
  );
}

function SevDot({ sev, x, y }: { sev?: Severity; x: number; y: number }) {
  const c = sev ? SEV_COLOR[sev] : undefined;
  if (!c) return null;
  return <circle cx={x} cy={y} r={3.5} fill={c} stroke="var(--ink-0)" strokeWidth={2} />;
}

function Labels({ n, name: full, lines, sev }: { n: LNode; name: string; lines: string[]; sev?: Severity }) {
  const [l1, l2] = lines;
  // Keep neighbours apart; the full name is in the inspector and the tooltip.
  const name = n.label === "below" && full.length > 24 ? `${full.slice(0, 22).trimEnd()}…` : full;
  if (n.label === "left") {
    const x = -GATEWAY_W / 2 - 18;
    return (
      <g textAnchor="end">
        <text x={x} y={-10} fill="var(--tx-1)" fontSize={15} fontWeight={650} className="lab-name">{name}</text>
        <text x={x} y={8} fill="var(--tx-3)" fontSize={10.5} fontFamily="JetBrains Mono, monospace">{l1}</text>
        <text x={x} y={23} fill="var(--tx-3)" fontSize={10.5}>{l2}</text>
        <SevDot sev={sev} x={x + 8} y={-14} />
      </g>
    );
  }
  if (n.label === "right") {
    const x = n.kind === "tv" || n.kind === "iot" ? 40 : 44;
    return (
      <g>
        <text x={x} y={-4} fill="var(--tx-1)" fontSize={13} fontWeight={600} className="lab-name">{name}</text>
        <text x={x} y={12} fill="var(--tx-3)" fontSize={10.5} fontFamily="JetBrains Mono, monospace">{l1}</text>
        {l2 && <text x={x} y={27} fill="var(--tx-2)" fontSize={10.5}>{l2}</text>}
        <SevDot sev={sev} x={x - 8} y={-8} />
      </g>
    );
  }
  if (n.label === "pill") {
    const w = Math.max(96, name.length * 7.6 + 30);
    return (
      <g>
        <rect x={-w / 2} y={44} width={w} height={22} rx={11} fill="var(--ink-1)" stroke="var(--hair-2)" />
        <text y={59} textAnchor="middle" fill="var(--tx-1)" fontSize={12.5} fontWeight={600} className="lab-name">{name}</text>
        <SevDot sev={sev} x={w / 2 - 2} y={46} />
      </g>
    );
  }
  return (
    <g textAnchor="middle">
      <text y={56} fill="var(--tx-1)" fontSize={13} fontWeight={600} className="lab-name">{name}</text>
      <text y={72} fill="var(--tx-3)" fontSize={10.5} fontFamily="JetBrains Mono, monospace">{l1}</text>
      {l2 && <text y={87} fill="var(--tx-2)" fontSize={10.5}>{l2}</text>}
      <SevDot sev={sev} x={name.length * 3.7 + 10} y={52} />
    </g>
  );
}

