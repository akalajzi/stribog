// Build a Snapshot from files on disk (exports, state JSON, notes). Node only.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parseExport, scrub, type DeviceRole, type DeviceSnapshot, type Notes, type RosRecord, type Snapshot } from "./ros.ts";

export interface SourceSpec {
  role: DeviceRole;
  export?: string;
  state?: string;
}

export interface StribogConfig {
  sources?: SourceSpec[];
  /** A saved Snapshot (or DeviceSnapshot[]) JSON, as written by `stribog collect`. Appended to `sources`. */
  snapshot?: string;
  /** A notes file to use instead of the one in the data directory (the demo ships its own). */
  notes?: string;
  /** Where Stribog keeps notes, the change log and agent tokens. Defaults to the platform's app-data directory. */
  dataDir?: string;
  sampleState?: boolean;
  /** The router the web app signs in to. Its data replaces the `router` file source while someone is signed in. */
  router?: RouterSpec;
  /** Development: write each live read (secrets already scrubbed) to this file, for building fixtures and fixing the model. */
  debug?: { saveSnapshot?: string };
}

export interface RouterSpec {
  /** Address as typed in a browser: `192.168.88.1`, `https://router.lan`. Without a scheme https is tried first. */
  url?: string;
  /** Seconds between reads while the app is open. */
  interval?: number;
}

export const expand = (p: string, base = process.cwd()) => resolve(base, p.replace(/^~(?=\/|$)/, homedir()));

export function readConfig(path: string): { config: StribogConfig; base: string } {
  const full = expand(path);
  return { config: JSON.parse(readFileSync(full, "utf8")) as StribogConfig, base: dirname(full) };
}

export function loadState(path: string): Record<string, RosRecord[]> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const out: Record<string, RosRecord[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_") || !Array.isArray(v)) continue;
    out[k] = (v as Record<string, unknown>[]).map((r) => scrub(Object.fromEntries(Object.entries(r).map(([a, b]) => [a, String(b)])) as RosRecord));
  }
  return out;
}

export function snapshotFromFiles(config: StribogConfig, base: string): Snapshot {
  const devices: DeviceSnapshot[] = (config.sources ?? []).map((s) => {
    const dev: DeviceSnapshot = { role: s.role, config: { meta: {}, menus: {} }, sources: [] };
    if (s.export) {
      const text = readFileSync(expand(s.export, base), "utf8");
      dev.config = parseExport(text);
      dev.sources.push({ kind: "export", label: s.export, at: dev.config.meta.exportedAt });
    }
    if (s.state) {
      dev.state = loadState(expand(s.state, base));
      dev.sources.push({ kind: "fixture", label: s.state });
    }
    return dev;
  });
  const saved = config.snapshot ? loadSnapshot(expand(config.snapshot, base)) : undefined;
  if (saved) devices.push(...saved.devices);
  const notes = config.notes ? (JSON.parse(readFileSync(expand(config.notes, base), "utf8")) as Notes) : saved?.notes;
  const exportTimes = devices.map((d) => d.config.meta.exportedAt).filter(Boolean).sort();
  return {
    collectedAt: saved?.collectedAt ?? exportTimes.at(-1) ?? new Date().toISOString(),
    devices,
    notes,
    sampleState: config.sampleState,
  };
}

/** Read a saved snapshot: a full Snapshot or a bare DeviceSnapshot[]. Secrets are scrubbed again on the way in. */
export function loadSnapshot(path: string): { collectedAt?: string; devices: DeviceSnapshot[]; notes?: Notes } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Snapshot | DeviceSnapshot[];
  const list = Array.isArray(raw) ? raw : (raw.devices ?? []);
  const clean = (menus: Record<string, RosRecord[]> | undefined) =>
    Object.fromEntries(Object.entries(menus ?? {}).map(([k, rows]) => [k, (rows ?? []).map((r) => scrub({ ...r }))]));
  const devices = list.map(
    (d): DeviceSnapshot => ({
      role: d.role ?? "router",
      config: { meta: d.config?.meta ?? {}, menus: clean(d.config?.menus) },
      state: d.state ? clean(d.state) : undefined,
      sources: d.sources?.length ? d.sources : [{ kind: "rest", label: path }],
    }),
  );
  return Array.isArray(raw) ? { devices } : { collectedAt: raw.collectedAt, devices, notes: raw.notes };
}
