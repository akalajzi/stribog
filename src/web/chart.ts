// Scales and time axes shared by the charts.

/** About four round steps (1, 2, 2.5 or 5 × 10ⁿ) from zero to just above the largest value. */
export function niceScale(v: number): { max: number; ticks: number[] } {
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw)!;
  const max = Math.ceil(v / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, k) => k * step) };
}

export function timeTicksFor(from: number, to: number): number[] {
  const span = to - from;
  const every = span <= 26 * 3600_000 ? 3 * 3600_000 : 24 * 3600_000;
  const first = Math.ceil(from / every) * every;
  const out: number[] = [];
  for (let t = first; t <= to; t += every) out.push(t);
  return out;
}

export const tickLabel = (t: number, span: number) =>
  span <= 26 * 3600_000 ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
