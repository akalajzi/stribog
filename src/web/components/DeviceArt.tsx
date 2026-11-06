// Original, stylised device drawings. Each is centred on (0, 0) and roughly 64 px tall.
// LEDs carry live state; nothing here is decoration only.

import type { ReactNode } from "react";
import type { Port } from "../api.ts";
import { GATEWAY_H, GATEWAY_W } from "../../core/layout.ts";

export const COLORS = {
  mg: "#93b4ff",
  g1: "#6fd6c4",
  w5: "#c4a6ff",
  w24: "#f0b983",
  w6: "#ff9ec7",
  up: "#d9d4c8",
  ok: "#63d6a2",
  warn: "#f3c25a",
  bad: "#ff7a72",
  tx3: "#5d636d",
  legacy: "#7c8088",
};

/** Shared gradients and filters; render once per SVG. */
export function ArtDefs() {
  return (
    <defs>
      <linearGradient id="mTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#454c59" /><stop offset="1" stopColor="#2a303a" /></linearGradient>
      <linearGradient id="mFront" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#252a33" /><stop offset=".5" stopColor="#1a1e25" /><stop offset="1" stopColor="#121519" /></linearGradient>
      <linearGradient id="mDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1c2027" /><stop offset="1" stopColor="#0e1014" /></linearGradient>
      <linearGradient id="plastic" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f6f3ec" /><stop offset=".55" stopColor="#dcd8cf" /><stop offset="1" stopColor="#b9b5ac" /></linearGradient>
      <linearGradient id="plasticTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e4e0d8" /></linearGradient>
      <linearGradient id="screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#263049" /><stop offset="1" stopColor="#0d1119" /></linearGradient>
      <radialGradient id="globe" cx=".35" cy=".3" r=".8"><stop offset="0" stopColor="#34405a" /><stop offset=".6" stopColor="#151b27" /><stop offset="1" stopColor="#0a0d12" /></radialGradient>
      <radialGradient id="apHalo"><stop offset="0" stopColor="#c4a6ff" stopOpacity=".14" /><stop offset=".6" stopColor="#c4a6ff" stopOpacity=".035" /><stop offset="1" stopColor="#c4a6ff" stopOpacity="0" /></radialGradient>
      <filter id="led" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="1.6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      <filter id="shadow" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="4" /></filter>
      <filter id="soft" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3" /></filter>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
    </defs>
  );
}

const Shadow = ({ w, y }: { w: number; y: number }) => <ellipse cx={0} cy={y} rx={w / 2 + 6} ry={4.5} fill="#000" opacity={0.65} filter="url(#shadow)" />;
const Led = ({ x, y, c, r = 1.5 }: { x: number; y: number; c: string; r?: number }) => <circle cx={x} cy={y} r={r} fill={c} filter="url(#led)" />;

/** A box with a lit top face: the basic 2.5D body for most hardware. */
function Box({ w, h, fill = "url(#mFront)", top = "url(#mTop)", rx = 4, children }: { w: number; h: number; fill?: string; top?: string; rx?: number; children?: ReactNode }) {
  const x = -w / 2;
  const y = -h / 2;
  return (
    <g>
      <Shadow w={w} y={h / 2 + 6} />
      <path d={`M${x + 5} ${y} H${x + w - 5} L${x + w} ${y + 7} H${x} Z`} fill={top} />
      <rect x={x} y={y + 7} width={w} height={h - 7} rx={rx} fill={fill} stroke="rgba(255,255,255,.08)" />
      <line x1={x + 1} y1={y + 7.5} x2={x + w - 1} y2={y + 7.5} stroke="rgba(255,255,255,.16)" />
      <g transform={`translate(${x} ${y})`}>{children}</g>
    </g>
  );
}

export function DeviceArt({ kind, status, accent = COLORS.g1, ghost }: { kind: string; status?: string; accent?: string; ghost?: boolean }) {
  const on = status === "online" || status === "unknown";
  const led = status === "offline" ? COLORS.tx3 : COLORS.ok;
  if (ghost) {
    return (
      <g opacity={0.85}>
        <rect x={-22} y={-28} width={44} height={56} rx={11} fill="rgba(196,166,255,.05)" stroke={COLORS.w5} strokeOpacity={0.7} strokeDasharray="4 4" />
        <circle cy={18} r={2} fill="none" stroke={COLORS.w5} strokeOpacity={0.7} />
      </g>
    );
  }
  switch (kind) {
    case "internet":
      return (
        <g>
          <circle r={30} fill="none" stroke={COLORS.mg} strokeOpacity={0.18} strokeWidth={4} filter="url(#soft)" />
          <circle r={24} fill="url(#globe)" stroke="rgba(217,212,200,.35)" strokeWidth={0.8} />
          <g fill="none" stroke={COLORS.up} strokeOpacity={0.28} strokeWidth={0.8}>
            <ellipse rx={10} ry={24} />
            <ellipse rx={18} ry={24} />
            <path d="M-21 -8h42M-24 0h48M-21 8h42" />
          </g>
        </g>
      );
    case "isp":
      return (
        <g>
          <Shadow w={36} y={36} />
          <path d="M-14 -32 H14 L18 -26 H-18 Z" fill="url(#plasticTop)" />
          <rect x={-18} y={-26} width={36} height={58} rx={4} fill="url(#plastic)" />
          {[-15, -8, -1, 6].map((y) => <Led key={y} x={-9} y={y} c={on ? COLORS.ok : COLORS.tx3} r={1.4} />)}
          <path d="M0 -16h10M0 -12h10M0 -8h10M0 -4h10" stroke="#a7a399" />
        </g>
      );
    case "ap":
      return (
        <g>
          <rect x={-22} y={-28} width={44} height={56} rx={11} fill="url(#plastic)" stroke="rgba(255,255,255,.6)" strokeWidth={0.6} />
          <rect x={-19} y={-25} width={38} height={50} rx={9} fill="none" stroke="rgba(0,0,0,.07)" />
          <text y={-3} textAnchor="middle" fill="#a29e95" fontSize={6} letterSpacing={1}>wAP</text>
          <Led x={0} y={18} c={on ? COLORS.w5 : COLORS.tx3} r={2} />
        </g>
      );
    case "router":
    case "switch":
      return (
        <g>
          <g fill="url(#plastic)">
            <rect x={-22} y={-30} width={4} height={24} rx={2} transform="rotate(-10 -20 -8)" />
            <rect x={-9} y={-32} width={4} height={24} rx={2} />
            <rect x={5} y={-32} width={4} height={24} rx={2} />
            <rect x={18} y={-30} width={4} height={24} rx={2} transform="rotate(10 20 -8)" />
          </g>
          <Shadow w={54} y={18} />
          <path d="M-23 -12 H23 L27 -8 H-27 Z" fill="url(#plasticTop)" />
          <rect x={-27} y={-8} width={54} height={14} rx={4} fill="url(#plastic)" />
          <circle cx={-18} cy={-1} r={1.4} fill={on ? COLORS.legacy : COLORS.tx3} />
        </g>
      );
    case "server":
      return (
        <Box w={50} h={70}>
          <rect x={8} y={14} width={3} height={48} rx={1.5} fill={accent} filter="url(#led)" />
          <path d="M18 18h24M18 23h24M18 28h24M18 33h24M18 38h24M18 43h24M18 48h24M18 53h24" stroke="rgba(255,255,255,.07)" />
          <Led x={41} y={62} c={led} />
        </Box>
      );
    case "nas":
      return (
        <Box w={56} h={64} fill="url(#mDark)">
          <rect x={8} y={15} width={18} height={42} rx={2} fill="#0a0c10" stroke="rgba(255,255,255,.07)" />
          <rect x={30} y={15} width={18} height={42} rx={2} fill="#0a0c10" stroke="rgba(255,255,255,.07)" />
          <rect x={13} y={50} width={8} height={2} rx={1} fill="#2c323d" />
          <rect x={35} y={50} width={8} height={2} rx={1} fill="#2c323d" />
          <Led x={17} y={21} c={on ? accent : COLORS.tx3} r={1.4} />
          <Led x={39} y={21} c={on ? accent : COLORS.tx3} r={1.4} />
        </Box>
      );
    case "desktop":
      return (
        <g>
          <Shadow w={44} y={34} />
          <rect x={-34} y={-30} width={68} height={44} rx={4} fill="#1a1e25" stroke="rgba(255,255,255,.12)" />
          <rect x={-30} y={-26} width={60} height={36} rx={2} fill="url(#screen)" />
          <path d="M-6 14 L-9 28 H9 L6 14 Z" fill="#2a303a" />
          <rect x={-16} y={27} width={32} height={3} rx={1.5} fill="#353c48" />
        </g>
      );
    case "laptop":
      return (
        <g>
          <Shadow w={70} y={22} />
          <rect x={-28} y={-24} width={56} height={38} rx={4} fill="#1d2129" stroke="rgba(255,255,255,.14)" />
          <rect x={-25} y={-21} width={50} height={31} rx={2} fill="url(#screen)" />
          <path d="M-36 14 H36 L33 20 H-33 Z" fill="#9ca1ab" />
          <rect x={-8} y={14} width={16} height={2} rx={1} fill="#6b707a" />
        </g>
      );
    case "phone":
    case "tablet": {
      const w = kind === "tablet" ? 40 : 26;
      const h = kind === "tablet" ? 54 : 50;
      return (
        <g>
          <Shadow w={w} y={h / 2 + 6} />
          <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={6} fill="#1b1f27" stroke="rgba(255,255,255,.18)" />
          <rect x={-w / 2 + 3} y={-h / 2 + 4} width={w - 6} height={h - 8} rx={3} fill="url(#screen)" />
        </g>
      );
    }
    case "tv":
      return (
        <g>
          <Shadow w={56} y={14} />
          <path d="M-22 -6 H22 L28 0 H-28 Z" fill="url(#mTop)" />
          <rect x={-28} y={0} width={56} height={11} rx={3} fill="url(#mDark)" stroke="rgba(255,255,255,.07)" />
          <Led x={20} y={5.5} c={on ? accent : COLORS.tx3} r={1.3} />
        </g>
      );
    case "printer":
      return (
        <g>
          <Shadow w={60} y={24} />
          <path d="M-26 -19 H26 L30 -11 H-30 Z" fill="#4a505b" />
          <rect x={-30} y={-11} width={60} height={30} rx={3} fill="#2b3038" />
          <rect x={-16} y={-2} width={32} height={5} rx={1} fill="#e9e6df" opacity={0.85} />
          <rect x={-20} y={3} width={40} height={3} rx={1} fill="#0b0d11" />
          <rect x={14} y={-8} width={11} height={5} rx={1} fill="#0b0d11" />
          <rect x={16} y={-6.5} width={4} height={2} fill={on ? COLORS.g1 : COLORS.tx3} opacity={0.8} />
        </g>
      );
    case "printer3d":
      return (
        <g>
          <Shadow w={52} y={34} />
          <path d="M-22 -32 H22 L26 -26 H-26 Z" fill="url(#mTop)" />
          <rect x={-26} y={-26} width={52} height={58} rx={4} fill="url(#mDark)" stroke="rgba(255,255,255,.1)" />
          <rect x={-20} y={-20} width={40} height={40} rx={2} fill="rgba(147,180,255,.08)" stroke="rgba(255,255,255,.12)" />
          <rect x={-8} y={4} width={16} height={10} rx={1} fill={accent} opacity={0.55} />
          <path d="M-14 -10 H14" stroke="#5d636d" strokeWidth={2} />
          <rect x={-3} y={-12} width={6} height={6} fill="#9aa0aa" />
          <Led x={18} y={26} c={on ? COLORS.ok : COLORS.tx3} r={1.3} />
        </g>
      );
    case "console":
      return (
        <Box w={56} h={30}>
          <Led x={8} y={20} c={on ? COLORS.mg : COLORS.tx3} />
        </Box>
      );
    case "camera":
      return (
        <g>
          <Shadow w={30} y={24} />
          <rect x={-16} y={-20} width={32} height={40} rx={10} fill="url(#plastic)" />
          <circle cy={-4} r={8} fill="#0d1119" />
          <circle cy={-4} r={3} fill="#263049" />
          <Led x={0} y={12} c={on ? COLORS.bad : COLORS.tx3} r={1.3} />
        </g>
      );
    case "iot":
      return (
        <g>
          <Shadow w={34} y={14} />
          <ellipse cx={0} cy={0} rx={18} ry={8} fill="url(#plasticTop)" />
          <path d="M-18 0 V6 A18 8 0 0 0 18 6 V0" fill="url(#plastic)" />
          <Led x={0} y={0} c={on ? COLORS.g1 : COLORS.tx3} r={1.4} />
        </g>
      );
    default:
      return (
        <Box w={44} h={40}>
          <text x={22} y={30} textAnchor="middle" fill="#5d636d" fontSize={13} fontWeight={600}>?</text>
        </Box>
      );
  }
}

export function speedColor(p: Port | undefined): string | undefined {
  if (!p) return undefined;
  if (p.zone === "upstream") return p.running === false ? undefined : p.deviceIds.includes("upstream") ? COLORS.up : COLORS.legacy;
  if (p.running === false) return undefined;
  if (p.speedMbps === undefined) return p.deviceIds.length ? COLORS.g1 : undefined;
  return p.speedMbps >= 2500 ? COLORS.mg : p.speedMbps >= 1000 ? COLORS.g1 : COLORS.warn;
}

/** The gateway's front panel. Port positions come from the layout so links meet their port. */
export function GatewayArt({ ports, portX, model }: { ports: Port[]; portX: Record<string, number>; model?: string }) {
  const w = GATEWAY_W;
  const h = GATEWAY_H;
  const x = -w / 2;
  const y = -h / 2;
  return (
    <g>
      <ellipse cx={0} cy={h / 2 + 8} rx={w / 2 + 8} ry={6} fill="#000" opacity={0.75} filter="url(#shadow)" />
      <path d={`M${x + 6} ${y} H${x + w - 6} L${x + w} ${y + 8} H${x} Z`} fill="url(#mTop)" />
      <rect x={x} y={y + 8} width={w} height={h - 8} rx={4} fill="url(#mFront)" stroke="rgba(255,255,255,.09)" />
      <line x1={x + 1} y1={y + 8.5} x2={x + w - 1} y2={y + 8.5} stroke="rgba(255,255,255,.2)" />
      <Led x={x + 14} y={y + 22} c={COLORS.ok} r={1.7} />
      <circle cx={x + 22} cy={y + 22} r={1.7} fill={COLORS.mg} opacity={0.7} />
      <text x={x + 12} y={y + 48} fill="#6b717c" fontSize={7} letterSpacing={1.4} fontFamily="JetBrains Mono, monospace">{(model ?? "ROUTER").replace(/[^\w+-]/g, "").slice(0, 10)}</text>
      <path d={`M${x + 44} ${y + 18}v28M${x + 48} ${y + 18}v28M${x + 52} ${y + 18}v28`} stroke="rgba(255,255,255,.06)" />
      {ports.map((p) => {
        const px = portX[p.name];
        if (px === undefined) return null;
        const sfp = p.kind === "sfp";
        const pw = sfp ? 16 : 12;
        const c = speedColor(p);
        return (
          <g key={p.name}>
            <rect x={px - pw / 2} y={y + 22} width={pw} height={11} rx={1.5} fill="#07090c" stroke="rgba(255,255,255,.16)" strokeWidth={0.8} />
            {c ? <rect x={px - pw / 2} y={y + 37} width={pw} height={2} rx={1} fill={c} filter="url(#led)" /> : null}
            {p.planned && !p.deviceIds.length ? <rect x={px - pw / 2} y={y + 36.5} width={pw} height={3} rx={1.5} fill="none" stroke={COLORS.w5} strokeWidth={0.8} strokeDasharray="1.5 1.5" /> : null}
            {p.poeWatts ? <path d={`M${px + 1} ${y + 12} l-3 4 h2.4 l-.6 3.2 3-4.2 h-2.4z`} fill={COLORS.g1} /> : null}
            <text x={px} y={y + 50} textAnchor="middle" fill="#5d636d" fontSize={6.5} fontFamily="JetBrains Mono, monospace">{sfp ? "S+" : p.name.replace(/^\D+/, "")}</text>
          </g>
        );
      })}
    </g>
  );
}

/** 16 px line glyphs for lists and orbit badges. */
export function Glyph({ kind, size = 16, color = "currentColor" }: { kind: string; size?: number; color?: string }) {
  const p = { fill: "none", stroke: color, strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const body = (() => {
    switch (kind) {
      case "phone": return <><rect x={7} y={2.5} width={10} height={19} rx={2.5} {...p} /><path d="M11 18.5h2" {...p} /></>;
      case "tablet": return <><rect x={4.5} y={3} width={15} height={18} rx={2} {...p} /><path d="M11 18h2" {...p} /></>;
      case "laptop": return <><rect x={5} y={5} width={14} height={10} rx={1.5} {...p} /><path d="M2.5 18.5h19" {...p} /></>;
      case "desktop": return <><rect x={3} y={4} width={18} height={12} rx={1.8} {...p} /><path d="M12 16v4M8 20h8" {...p} /></>;
      case "server": return <><rect x={4} y={3.5} width={16} height={7} rx={1.8} {...p} /><rect x={4} y={13.5} width={16} height={7} rx={1.8} {...p} /><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5" {...p} /></>;
      case "nas": return <><rect x={5} y={3} width={14} height={18} rx={2} {...p} /><path d="M9 7v6M12 7v6M15 7v6M9 17h.01" {...p} /></>;
      case "ap": return <><circle cx={12} cy={13} r={7.5} {...p} /><circle cx={12} cy={13} r={1.4} {...p} /><path d="M8.6 5.2a9 9 0 0 1 6.8 0" {...p} /></>;
      case "tv": return <><rect x={3} y={5} width={18} height={12} rx={1.8} {...p} /><path d="M9 20h6" {...p} /></>;
      case "printer": return <><path d="M7 9V4h10v5" {...p} /><rect x={3.5} y={9} width={17} height={7.5} rx={1.8} {...p} /><path d="M7 14h10v6H7z" {...p} /></>;
      case "printer3d": return <><path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" {...p} /><path d="M4 7.5 12 12l8-4.5M12 12v9" {...p} /></>;
      case "router": case "isp": case "switch": return <><rect x={3} y={13} width={18} height={7} rx={2} {...p} /><path d="M7 16.5h.01M10 16.5h.01M13 16.5h.01" {...p} /><path d="M8 9.5a5.5 5.5 0 0 1 8 0M10.2 11.4a2.4 2.4 0 0 1 3.6 0" {...p} /></>;
      case "internet": return <><circle cx={12} cy={12} r={8.5} {...p} /><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.4 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.4-3.6-8.5s1-5.9 3.6-8.5z" {...p} /></>;
      case "console": return <><path d="M7 9h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L14.5 14h-5l-1.1 1.8A3 3 0 0 1 3 14v-1a4 4 0 0 1 4-4z" {...p} /><path d="M8 11.5v2M7 12.5h2M16 12h.01" {...p} /></>;
      case "camera": return <><rect x={3} y={7} width={13} height={10} rx={2} {...p} /><path d="m16 11 5-3v8l-5-3" {...p} /></>;
      case "iot": return <><circle cx={12} cy={12} r={3} {...p} /><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4" {...p} /></>;
      default: return <><rect x={4} y={4} width={16} height={16} rx={4} {...p} /><path d="M10 10a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1M12 16h.01" {...p} /></>;
    }
  })();
  return <svg width={size} height={size} viewBox="0 0 24 24" style={{ flex: "none" }}>{body}</svg>;
}

export const mediumColor = (m: string) =>
  m === "2.5g" ? COLORS.mg : m === "1g" || m === "wired" ? COLORS.g1 : m === "100m" ? COLORS.warn : m === "wan" ? COLORS.up : m === "wifi-2.4" ? COLORS.w24 : m === "wifi-5" ? COLORS.w5 : m === "wifi-6" ? COLORS.w6 : m === "planned" ? COLORS.w5 : COLORS.tx3;

export const bandColor = (b?: string) => (b === "2.4" ? COLORS.w24 : b === "6" ? COLORS.w6 : COLORS.w5);
