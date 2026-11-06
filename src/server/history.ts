// What Stribog remembers about devices over time, in the data directory:
//   history/samples-YYYY-MM-DD.jsonl  one line a minute: per device online, down, up, signal
//   history/talks-YYYY-MM-DD.json     per device, per other end and port: bytes, first and last seen
// Recorded while someone is signed in to the router (see recorder.ts). Kept for 30 days.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Flow } from "../core/activity.ts";

export const KEEP_DAYS = 30;

/** [time ms, online 0/1, down bps, up bps, signal dBm] */
export type Sample = [number, 0 | 1, number | null, number | null, number | null];

export interface Talk extends Omit<Flow, "connections" | "fasttracked"> {
  first: string;
  last: string;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export class HistoryStore {
  constructor(readonly dir: string) {}

  private file(kind: "samples" | "talks", d: string) {
    return join(this.dir, `${kind}-${d}.${kind === "samples" ? "jsonl" : "json"}`);
  }

  appendSamples(t: number, byMac: Record<string, [0 | 1, number | null, number | null, number | null]>) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.file("samples", day(t)), JSON.stringify({ t, d: byMac }) + "\n", { mode: 0o600 });
  }

  /** Add byte deltas to today's talks of each device. */
  addTalks(t: number, byMac: Map<string, Flow[]>) {
    if (!byMac.size) return;
    const f = this.file("talks", day(t));
    const all: Record<string, Record<string, Talk>> = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    const at = new Date(t).toISOString();
    for (const [mac, flows] of byMac) {
      const mine = (all[mac] ??= {});
      for (const fl of flows) {
        const key = `${fl.direction}|${fl.protocol}|${fl.remote}|${fl.port ?? ""}`;
        const prev = mine[key];
        const { connections: _c, fasttracked: _f, ...rest } = fl;
        mine[key] = prev
          ? { ...prev, ...rest, names: fl.names ?? prev.names, down: prev.down + fl.down, up: prev.up + fl.up, last: at }
          : { ...rest, first: at, last: at };
      }
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, f);
  }

  /** One device's samples in [from, to], at most `points` of them (evenly thinned). */
  samples(mac: string, from: number, to: number, points = 360): Sample[] {
    const out: Sample[] = [];
    for (const d of this.days(from, to)) {
      const f = this.file("samples", d);
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line) continue;
        const { t, d: byMac } = JSON.parse(line) as { t: number; d: Record<string, [0 | 1, number | null, number | null, number | null]> };
        if (t < from || t > to) continue;
        const v = byMac[mac];
        if (v) out.push([t, ...v]);
      }
    }
    if (out.length <= points) return out;
    // Keep peaks: each bucket reports its busiest minute, so a short burst is not averaged away.
    const size = Math.ceil(out.length / points);
    const thin: Sample[] = [];
    for (let i = 0; i < out.length; i += size) {
      const b = out.slice(i, i + size);
      const peak = b.reduce((a, s) => ((s[2] ?? 0) + (s[3] ?? 0) > (a[2] ?? 0) + (a[3] ?? 0) ? s : a), b[0]!);
      thin.push([b[0]![0], b.some((s) => s[1]) ? 1 : 0, peak[2], peak[3], peak[4]]);
    }
    return thin;
  }

  /** One device's talks over [from, to], merged across days, biggest first. */
  talks(mac: string, from: number, to: number): Talk[] {
    const merged = new Map<string, Talk>();
    for (const d of this.days(from, to)) {
      const f = this.file("talks", d);
      if (!existsSync(f)) continue;
      const mine = (JSON.parse(readFileSync(f, "utf8")) as Record<string, Record<string, Talk>>)[mac] ?? {};
      for (const [k, t] of Object.entries(mine)) {
        if (Date.parse(t.last) < from || Date.parse(t.first) > to) continue;
        const p = merged.get(k);
        merged.set(k, p ? { ...p, down: p.down + t.down, up: p.up + t.up, first: p.first < t.first ? p.first : t.first, last: p.last > t.last ? p.last : t.last, names: t.names ?? p.names } : { ...t });
      }
    }
    return [...merged.values()].sort((a, b) => b.down + b.up - (a.down + a.up));
  }

  /** When recording began, as far as the files go. */
  since(): string | undefined {
    if (!existsSync(this.dir)) return undefined;
    const days = readdirSync(this.dir).map((f) => /^samples-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1]).filter(Boolean).sort();
    if (!days.length) return undefined;
    const first = readFileSync(this.file("samples", days[0]!), "utf8").split("\n")[0];
    return first ? new Date((JSON.parse(first) as { t: number }).t).toISOString() : undefined;
  }

  prune(now = Date.now()) {
    if (!existsSync(this.dir)) return;
    const cut = day(now - KEEP_DAYS * 86_400_000);
    for (const f of readdirSync(this.dir)) {
      const d = /-(\d{4}-\d{2}-\d{2})\./.exec(f)?.[1];
      if (d && d < cut) rmSync(join(this.dir, f));
    }
  }

  private days(from: number, to: number): string[] {
    const out: string[] = [];
    for (let t = from - (from % 86_400_000); t <= to; t += 86_400_000) out.push(day(t));
    return out;
  }
}
