// Notes: what people and their agents tell Stribog that the router cannot know. One JSON file,
// written atomically, plus an append-only change log. Both live in the data directory.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KINDS } from "../core/classify.ts";
import { normMac } from "../core/net.ts";
import type { DeviceNotes, Notes, ServiceNote } from "../core/ros.ts";

/** $STRIBOG_DATA, the config's dataDir, or the platform's app-data directory. */
export function dataDir(configured?: string): string {
  const env = process.env.STRIBOG_DATA;
  if (env) return env;
  if (configured) return configured;
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Stribog");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Stribog");
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "stribog");
}

export class NotesError extends Error {}

export interface AuditEntry {
  at: string;
  /** `device:AA:BB:CC:DD:EE:FF` or `network`. */
  target: string;
  before: unknown;
  after: unknown;
}

/**
 * Notes in one file. `persist: false` keeps changes in memory (the demo network), so trying
 * things out never touches the shipped fixture.
 */
export class NotesStore {
  private cache?: { mtime: number; notes: Notes };
  private memory?: Notes;

  constructor(
    readonly path: string,
    readonly auditPath: string | undefined,
    readonly persist = true,
  ) {}

  get(): Notes {
    if (this.memory) return this.memory;
    if (!existsSync(this.path)) return {};
    const mtime = statSync(this.path).mtimeMs;
    if (this.cache?.mtime !== mtime) this.cache = { mtime, notes: JSON.parse(readFileSync(this.path, "utf8")) as Notes };
    return this.cache.notes;
  }

  device(mac: string): DeviceNotes | undefined {
    return this.get().devices?.[normMac(mac)];
  }

  /** Merge `patch` into a device's notes; `null` clears a field. `replace` drops fields not in `patch`. */
  updateDevice(mac: string, patch: Record<string, unknown>, replace = false): DeviceNotes {
    const key = normMac(mac);
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(key)) throw new NotesError(`“${mac}” is not a MAC address.`);
    const notes = structuredClone(this.get());
    const before = notes.devices?.[key];
    const next = cleanDevice({ ...(replace ? {} : before), ...validateDevice(patch) });
    notes.devices ??= {};
    if (Object.keys(next).length) notes.devices[key] = { ...next, updatedAt: new Date().toISOString() };
    else delete notes.devices[key];
    this.save(notes, { target: `device:${key}`, before: before ?? null, after: notes.devices[key] ?? null });
    return notes.devices[key] ?? {};
  }

  deleteDevice(mac: string) {
    const key = normMac(mac);
    const notes = structuredClone(this.get());
    const before = notes.devices?.[key];
    if (!before) return;
    delete notes.devices![key];
    this.save(notes, { target: `device:${key}`, before, after: null });
  }

  /** Network-wide notes: site name, ISP, free-form notes. */
  updateNetwork(patch: Record<string, unknown>): Notes {
    const v = validateNetwork(patch);
    const notes = structuredClone(this.get());
    const before = { site: notes.site, notes: notes.notes, upstream: notes.upstream };
    for (const [k, val] of Object.entries(v)) {
      if (val === null) delete (notes as Record<string, unknown>)[k];
      else (notes as Record<string, unknown>)[k] = val;
    }
    if (notes.upstream && !Object.values(notes.upstream).some(Boolean)) delete notes.upstream;
    this.save(notes, { target: "network", before, after: { site: notes.site, notes: notes.notes, upstream: notes.upstream } });
    return notes;
  }

  audit(limit = 200): AuditEntry[] {
    if (!this.auditPath || !existsSync(this.auditPath)) return [];
    return readFileSync(this.auditPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as AuditEntry)
      .reverse();
  }

  private save(notes: Notes, change: Omit<AuditEntry, "at">) {
    if (!this.persist) {
      this.memory = notes;
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(notes, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
    this.cache = undefined;
    if (this.auditPath) appendFileSync(this.auditPath, JSON.stringify({ at: new Date().toISOString(), ...change }) + "\n", { mode: 0o600 });
  }
}

// ---- validation -------------------------------------------------------------------

const LIMITS = { name: 80, label: 40, labels: 20, description: 500, notes: 10_000, services: 50, serviceText: 300 };

const text = (v: unknown, field: string, max: number): string | null | undefined => {
  if (v === undefined || v === null) return v;
  if (typeof v !== "string") throw new NotesError(`${field} must be text.`);
  const t = v.trim();
  if (t.length > max) throw new NotesError(`${field} is longer than ${max} characters.`);
  return t || null;
};

function validateDevice(p: Record<string, unknown>): Partial<Record<keyof DeviceNotes, unknown>> {
  const allowed = new Set(["name", "kind", "labels", "description", "services", "notes", "only24", "sameAs", "separate"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) throw new NotesError(`Unknown field “${k}”. Use: ${[...allowed].join(", ")}.`);
  const out: Partial<Record<keyof DeviceNotes, unknown>> = {};
  if ("name" in p) out.name = text(p.name, "name", LIMITS.name);
  if ("description" in p) out.description = text(p.description, "description", LIMITS.description);
  if ("notes" in p) out.notes = text(p.notes, "notes", LIMITS.notes);
  if ("kind" in p) {
    const k = text(p.kind, "kind", 20);
    if (k && !KINDS.includes(k as never)) throw new NotesError(`kind must be one of: ${KINDS.join(", ")}.`);
    out.kind = k;
  }
  if ("only24" in p) {
    if (p.only24 !== null && typeof p.only24 !== "boolean") throw new NotesError("only24 must be true or false.");
    out.only24 = p.only24;
  }
  if ("separate" in p) {
    if (p.separate !== null && typeof p.separate !== "boolean") throw new NotesError("separate must be true or false.");
    out.separate = p.separate || null;
  }
  if ("sameAs" in p) {
    const v = text(p.sameAs, "sameAs", 40);
    if (v && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(normMac(v))) throw new NotesError("sameAs must be a MAC address, like 02:00:5E:10:00:01.");
    out.sameAs = v ? normMac(v) : v;
  }
  if ("labels" in p) {
    if (p.labels === null) out.labels = null;
    else {
      if (!Array.isArray(p.labels)) throw new NotesError("labels must be a list of text.");
      const labels = [...new Set(p.labels.map((l, i) => text(l, `labels[${i}]`, LIMITS.label)).filter((l): l is string => !!l))];
      if (labels.length > LIMITS.labels) throw new NotesError(`At most ${LIMITS.labels} labels.`);
      out.labels = labels.length ? labels : null;
    }
  }
  if ("services" in p) {
    if (p.services === null) out.services = null;
    else {
      if (!Array.isArray(p.services)) throw new NotesError("services must be a list.");
      if (p.services.length > LIMITS.services) throw new NotesError(`At most ${LIMITS.services} services.`);
      out.services = p.services.map((s, i) => validateService(s, i));
      if (!(out.services as unknown[]).length) out.services = null;
    }
  }
  return out;
}

function validateService(s: unknown, i: number): ServiceNote {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new NotesError(`services[${i}] must be an object with at least a name.`);
  const r = s as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["name", "port", "protocol", "url", "note"].includes(k)) throw new NotesError(`services[${i}]: unknown field “${k}”.`);
  const name = text(r.name, `services[${i}].name`, LIMITS.name);
  if (!name) throw new NotesError(`services[${i}] needs a name.`);
  const out: ServiceNote = { name };
  if (r.port !== undefined && r.port !== null) {
    if (!Number.isInteger(r.port) || (r.port as number) < 1 || (r.port as number) > 65535) throw new NotesError(`services[${i}].port must be a number from 1 to 65535.`);
    out.port = r.port as number;
  }
  const protocol = text(r.protocol, `services[${i}].protocol`, 20);
  if (protocol) out.protocol = protocol.toLowerCase();
  const url = text(r.url, `services[${i}].url`, LIMITS.serviceText);
  if (url) {
    if (!/^https?:\/\//i.test(url)) throw new NotesError(`services[${i}].url must start with http:// or https://.`);
    out.url = url;
  }
  const note = text(r.note, `services[${i}].note`, LIMITS.serviceText);
  if (note) out.note = note;
  return out;
}

function validateNetwork(p: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(["site", "notes", "upstream"]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) throw new NotesError(`Unknown field “${k}”. Use: ${[...allowed].join(", ")}.`);
  const out: Record<string, unknown> = {};
  if ("site" in p) out.site = text(p.site, "site", LIMITS.name);
  if ("notes" in p) out.notes = text(p.notes, "notes", LIMITS.notes);
  if ("upstream" in p) {
    if (p.upstream === null) out.upstream = null;
    else {
      if (typeof p.upstream !== "object" || Array.isArray(p.upstream)) throw new NotesError("upstream must be an object with name, model and/or isp.");
      const u = p.upstream as Record<string, unknown>;
      for (const k of Object.keys(u)) if (!["name", "model", "isp"].includes(k)) throw new NotesError(`upstream: unknown field “${k}”.`);
      const v = Object.fromEntries((["name", "model", "isp"] as const).map((k) => [k, text(u[k], `upstream.${k}`, LIMITS.name) ?? undefined]).filter(([, x]) => x));
      out.upstream = Object.keys(v).length ? v : null;
    }
  }
  return out;
}

/** Drop cleared (null/empty) fields; keep `updatedAt` out so an emptied entry disappears. */
function cleanDevice(d: Record<string, unknown>): DeviceNotes {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (k !== "updatedAt" && v !== null && v !== undefined && v !== "") out[k] = v;
  return out as DeviceNotes;
}
