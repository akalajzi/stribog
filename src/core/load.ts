// Build a Snapshot from files on disk (exports, state JSON, overrides). Node only.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parseExport, scrub, type DeviceRole, type DeviceSnapshot, type Overrides, type RosRecord, type Snapshot } from "./ros.ts";

export interface SourceSpec {
  role: DeviceRole;
  export?: string;
  state?: string;
}

export interface StribogConfig {
  sources?: SourceSpec[];
  overrides?: string;
  sampleState?: boolean;
  live?: LiveSpec;
}

export interface LiveSpec {
  url: string;
  user: string;
  passwordFile?: string;
  /** Accept a self-signed certificate on https. */
  insecure?: boolean;
  /** Seconds between polls when serving. */
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
  const overrides = config.overrides ? (JSON.parse(readFileSync(expand(config.overrides, base), "utf8")) as Overrides) : undefined;
  const exportTimes = devices.map((d) => d.config.meta.exportedAt).filter(Boolean).sort();
  return {
    collectedAt: exportTimes.at(-1) ?? new Date().toISOString(),
    devices,
    overrides,
    sampleState: config.sampleState,
  };
}
