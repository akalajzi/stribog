import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from "react";
import type { Device, LNode, NetworkPayload, Severity } from "../api.ts";
import { GATEWAY_W, orbitRadius } from "../../core/layout.ts";
import { UPSTREAM_GROUP } from "../../core/layout.ts";
import { ArtDefs, bandColor, COLORS, DeviceArt, GatewayArt, Glyph, mediumColor } from "./DeviceArt.tsx";

const SEV_COLOR: Partial<Record<Severity, string>> = { critical: COLORS.bad, warning: COLORS.warn, suggestion: "var(--idea)" };
const SEV_RANK: Severity[] = ["critical", "warning", "suggestion", "info", "pass"];

interface Props {
  data: NetworkPayload;
  selected?: string;
  highlight?: string[];
  onSelect: (id?: string) => void;
}

type View = { x: number; y: number; w: number; h: number };

export function Topology({ data, selected, highlight, onSelect }: Props) {
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

          {layout.orbits.map((o) => (
            <g key={o.apId} opacity={dim(o.apId) ? 0.35 : 1}>
              <circle cx={o.x} cy={o.y} r={orbitRadius(-80) + 20} fill="url(#apHalo)" />
              {o.rings.map((r, i) => (
                <circle key={r.dbm} cx={o.x} cy={o.y} r={r.r} fill="none" stroke={COLORS.w5} strokeOpacity={0.13} strokeDasharray={i === 0 ? undefined : i === 1 ? "2 4" : "1 6"} />
              ))}
              <text x={o.x + 16} y={o.y - orbitRadius(-80) - 6} fill="var(--tx-3)" fontSize={9.5} fontFamily="JetBrains Mono, monospace">rings {o.rings.map((r) => r.dbm).join(" · ")} dBm</text>
            </g>
          ))}

          {layout.links.map((l) => {
            const c = mediumColor(l.medium);
            const dashed = l.medium === "planned" ? "5 6" : l.medium === "legacy" ? "2 5" : l.medium.startsWith("wifi") ? "1 5" : undefined;
            const faded = dim(l.to) && dim(l.from);
            const to = byId.get(l.to);
            const alive = !dashed && to?.status === "online";
            const width = l.medium === "2.5g" ? 2.6 : l.medium === "wan" ? 2.2 : 2;
            return (
              <g key={l.id} opacity={faded ? 0.25 : 1}>
                {l.medium === "2.5g" && <path d={l.d} fill="none" stroke={c} strokeWidth={4} opacity={0.45} filter="url(#soft)" />}
                <path id={l.id} d={l.d} fill="none" stroke={c} strokeOpacity={l.medium === "wan" ? 0.5 : l.medium.startsWith("wifi") ? 0.55 : 1} strokeWidth={dashed ? 1.6 : width} strokeDasharray={dashed} strokeLinecap="round" />
                {alive &&
                  [0, 1, 2].slice(0, l.weight > 0.6 ? 3 : 2).map((k) => (
                    <circle key={k} r={2.3} fill="var(--tx-1)" opacity={0.9}>
                      <animateMotion dur={`${l.weight > 0.6 ? 1.6 : 2.4}s`} begin={`-${k * (l.weight > 0.6 ? 0.55 : 1.2)}s`} repeatCount="indefinite">
                        <mpath href={`#${l.id}`} />
                      </animateMotion>
                    </circle>
                  ))}
                {l.label && l.labelAt && (
                  <text x={l.labelAt.x} y={l.labelAt.y} textAnchor={l.labelAt.anchor} fontSize={10.5} fontFamily="JetBrains Mono, monospace" fill={c} fillOpacity={l.medium === "wan" || l.medium === "legacy" ? 0.6 : 0.85}>
                    {l.label}
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
            if (n.client) return <ClientBadge key={n.id} n={n} d={d} sel={isSel} sev={sev} dim={dim(n.id)} onClick={click(n.id)} />;

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
              </g>
            );
          })}

          {router && lan && <title>{lan.label}</title>}
        </svg>
      )}

      <div className="legend">
        <span><i style={{ borderColor: COLORS.mg }} />2.5G</span>
        <span><i style={{ borderColor: COLORS.g1 }} />1G</span>
        <span><i style={{ borderColor: COLORS.w5, borderTopStyle: "dotted" }} />5 GHz</span>
        <span><i style={{ borderColor: COLORS.w24, borderTopStyle: "dotted" }} />2.4 GHz</span>
        <span><i style={{ borderColor: COLORS.up, opacity: 0.6 }} />upstream</span>
        <span><i style={{ borderColor: COLORS.tx3, borderTopStyle: "dashed" }} />legacy</span>
        {model.planned.length > 0 && <span><i style={{ borderColor: COLORS.w5, borderTopStyle: "dashed" }} />planned</span>}
        <span>· moving dots = link up</span>
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
      const n = model.devices.filter((x) => x.parent === d.id && x.via?.kind === "wifi").length;
      return [`${d.ip ?? ""}`, `${d.model ?? "AP"} · ${n} Wi-Fi client${n === 1 ? "" : "s"}`];
    }
    default: {
      const dns = lan?.dhcp?.dns.includes(d.ip ?? "-") ? "DNS for LAN" : "";
      return [d.ip ?? "", [dns, ...(d.labels ?? []).slice(0, 2)].filter(Boolean).join(" · ")];
    }
  }
}

function SevDot({ sev, x, y }: { sev?: Severity; x: number; y: number }) {
  const c = sev ? SEV_COLOR[sev] : undefined;
  if (!c) return null;
  return <circle cx={x} cy={y} r={3.5} fill={c} stroke="var(--ink-0)" strokeWidth={2} />;
}

function Labels({ n, name, lines, sev }: { n: LNode; name: string; lines: string[]; sev?: Severity }) {
  const [l1, l2] = lines;
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

function ClientBadge({ n, d, sel, sev, dim, onClick }: { n: LNode; d: Device; sel: boolean; sev?: Severity; dim: boolean; onClick: () => void }) {
  const c = bandColor(d.via?.band);
  const standby = d.status !== "online";
  const right = n.side !== "left";
  const tx = right ? 20 : -20;
  const anchor = right ? "start" : "end";
  const sig = d.via?.signal;
  return (
    <g transform={`translate(${n.x} ${n.y})`} className="node" onClick={onClick} opacity={dim ? 0.3 : 1}>
      <rect className="hit" x={right ? -16 : -150} y={-18} width={166} height={36} />
      {sel && <SelectRing r={20} />}
      <circle r={13} fill="var(--ink-1)" stroke={c} strokeWidth={1.4} strokeDasharray={standby ? "2 2.5" : undefined} />
      <g transform="translate(-7 -7)" color={standby ? "var(--tx-2)" : "var(--tx-1)"}>
        <Glyph kind={d.kind} size={14} />
      </g>
      <text x={tx} y={-1} textAnchor={anchor} fill={standby ? "var(--tx-2)" : "var(--tx-1)"} fontSize={11.5} className="lab-name">{d.name}</text>
      <text x={tx} y={12} textAnchor={anchor} fill="var(--tx-3)" fontSize={9.5} fontFamily="JetBrains Mono, monospace">
        {sig !== undefined ? `${sig}` : "?"} · {d.via?.band} GHz{d.via?.ssid ? ` · ${d.via.ssid}` : ""}
      </text>
      <SevDot sev={sev} x={9} y={-10} />
    </g>
  );
}
