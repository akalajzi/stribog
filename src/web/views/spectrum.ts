// Channel geometry for the Wi-Fi spectrum: which channels each radio occupies, which blocks the
// channel plan allows, and where a planned access point would have to go. Pure, no React.

import type { NetworkModel, Radio } from "../../core/model.ts";
import { channelOf, coveredChannels, isDfs, type Band } from "../../core/net.ts";

/** 20 MHz channel numbers drawn on the axis, in contiguous runs (a gap is drawn between runs). */
export const AXIS: Record<Band, number[][]> = {
  "2.4": [range(1, 13, 1)],
  // EU: UNII-1/2 (36–64), UNII-2e (100–144), and the short-range 149–165 block.
  "5": [range(36, 64, 4), range(100, 144, 4), range(149, 165, 4)],
  "6": [range(1, 233, 4)],
};

export const BAND_LABEL: Record<Band, string> = { "2.4": "2.4 GHz", "5": "5 GHz", "6": "6 GHz" };

function range(a: number, b: number, step: number): number[] {
  const out: number[] = [];
  for (let c = a; c <= b; c += step) out.push(c);
  return out;
}

/** Widest width the plan allows ("20/40/80mhz" → 80), used when the radio is not up yet. */
export function planMaxWidth(r: Radio): number {
  const ws = (r.plan?.width ?? "").match(/\d+/g)?.map(Number).filter((n) => n >= 20) ?? [];
  return r.current?.width ?? (ws.length ? Math.max(...ws) : 20);
}

export interface Block {
  channels: number[];
  primary: number;
  width: number;
}

export const blockOf = (band: Band, primary: number, width: number): Block => ({ channels: coveredChannels(band, primary, width), primary, width });

export function radioBlock(r: Radio): Block | undefined {
  return r.current ? blockOf(r.band, r.current.channel, r.current.width) : undefined;
}

/** Channels the plan allows across all radios in a band (primaries only, as RouterOS lists them). */
export function planChannels(radios: Radio[]): number[] {
  const set = new Set<number>();
  for (const r of radios) for (const f of r.plan?.frequencies ?? []) set.add(channelOf(f));
  return [...set].sort((a, b) => a - b);
}

/** Distinct blocks the plan can produce at a given width. */
export function planBlocks(band: Band, plan: number[], width: number): Block[] {
  const seen = new Map<string, Block>();
  for (const ch of plan) {
    const b = blockOf(band, ch, width);
    const key = b.channels.join(",");
    if (!seen.has(key)) seen.set(key, b);
  }
  return [...seen.values()];
}

export const shared = (a: number[], b: number[]) => a.filter((c) => b.includes(c));

export const blockSpan = (b: Block) => {
  const lo = Math.min(...b.channels);
  const hi = Math.max(...b.channels);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
};

export const blockIsDfs = (band: Band, b: Block) => band === "5" && b.channels.some(isDfs);

export interface Placement {
  plannedId: string;
  name: string;
  band: Band;
  block: Block;
  /** Radios whose block shares at least one channel with this placement. */
  overlaps: { radio: Radio | { id: string; apId: string }; channels: number[] }[];
}

/**
 * Where each planned access point would land if it used the same channel plan as the existing
 * radios: the allowed block with the least overlap, and among equals the one furthest away.
 * Planned APs are placed one after another, so the second planned AP sees the first.
 */
export function placePlanned(model: NetworkModel): Placement[] {
  const planned = model.planned.filter((p) => p.kind === "ap");
  const out: Placement[] = [];
  for (const band of ["2.4", "5", "6"] as Band[]) {
    const radios = model.radios.filter((r) => r.band === band);
    const plan = planChannels(radios);
    if (!radios.length || !plan.length) continue;
    const width = Math.max(...radios.map(planMaxWidth));
    const taken: { radio: Placement["overlaps"][number]["radio"]; block: Block }[] = radios.flatMap((r) => {
      const b = radioBlock(r);
      return b ? [{ radio: r, block: b }] : [];
    });
    for (const p of planned) {
      const candidates = planBlocks(band, plan, width).map((block) => {
        const overlaps = taken.map((t) => ({ radio: t.radio, channels: shared(block.channels, t.block.channels) })).filter((o) => o.channels.length);
        const cost = overlaps.reduce((s, o) => s + o.channels.length, 0);
        const distance = taken.length ? Math.min(...taken.map((t) => Math.abs(t.block.primary - block.primary))) : 0;
        return { block, overlaps, cost, distance };
      });
      candidates.sort((a, b) => a.cost - b.cost || b.distance - a.distance || a.block.primary - b.block.primary);
      const best = candidates[0];
      if (!best) continue;
      out.push({ plannedId: p.id, name: p.name, band, block: best.block, overlaps: best.overlaps });
      taken.push({ radio: { id: `planned:${p.id}`, apId: `planned:${p.id}` }, block: best.block });
    }
  }
  return out;
}

/** Signal zones, matching the wording the review uses. */
export const SIGNAL_ZONES = [
  { from: -95, to: -72, label: "Weak", tint: "var(--bad)" },
  { from: -72, to: -65, label: "Fair", tint: "var(--warn)" },
  { from: -65, to: -55, label: "Good", tint: "var(--g1)" },
  { from: -55, to: -25, label: "Excellent", tint: "var(--ok)" },
] as const;

export const signalWord = (s?: number) => (s === undefined ? "unknown" : s >= -55 ? "excellent" : s >= -65 ? "good" : s >= -72 ? "fair" : "weak");

/** "wpa2-psk,wpa3-psk" → "WPA2 + WPA3" */
export function securityLabel(auth: string[]): string {
  const fam = [...new Set(auth.map((a) => a.match(/^(wpa\d?|owe|wep)/i)?.[1]?.toUpperCase() ?? a.toUpperCase()))];
  if (!fam.length) return "Open";
  const enterprise = auth.some((a) => /eap/i.test(a));
  return fam.join(" + ") + (enterprise ? " Enterprise" : "");
}
