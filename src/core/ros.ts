// RouterOS data in one shape, whatever the source.
//
// A RouterOS device is a set of menus ("/interface/bridge/port", "/ip/dhcp-server/lease", ...),
// each holding records of string properties. An `/export` script and the REST API both reduce
// to this shape, so everything downstream (model, rules, UI) works the same for an offline export
// and a live router. Exports omit default values; use `prop()` with an explicit default.

export type RosRecord = Record<string, string> & {
  /** Comment lines that RouterOS printed directly above this item in an export. */
  _notes?: string;
};

export interface RosMeta {
  exportedAt?: string;
  version?: string;
  model?: string;
  softwareId?: string;
}

export interface RosConfig {
  meta: RosMeta;
  menus: Record<string, RosRecord[]>;
}

export type DeviceRole = "router" | "cap" | "switch" | "other";

export interface SourceInfo {
  kind: "export" | "rest" | "fixture";
  label: string;
  at?: string;
}

export interface DeviceSnapshot {
  role: DeviceRole;
  config: RosConfig;
  /** Runtime state menus (registration table, leases, bridge hosts...). Only from a live router or a fixture. */
  state?: Record<string, RosRecord[]>;
  sources: SourceInfo[];
}

export interface Snapshot {
  collectedAt: string;
  devices: DeviceSnapshot[];
  overrides?: Overrides;
  /** True when runtime state is sample data rather than read from a router. */
  sampleState?: boolean;
}

/** What only the user can know: names, kinds, rooms, intent. Keyed by upper-case MAC. */
export interface Overrides {
  site?: string;
  devices?: Record<string, DeviceOverride>;
  upstream?: { name?: string; model?: string; isp?: string };
  networks?: Record<string, { role?: NetworkRole; label?: string }>;
  planned?: PlannedDevice[];
}

export interface DeviceOverride {
  name?: string;
  kind?: string;
  room?: string;
  owner?: string;
  /** Hardware that can only use 2.4 GHz (many printers and IoT devices). */
  only24?: boolean;
}

export interface PlannedDevice {
  id: string;
  name: string;
  kind: string;
  port?: string;
  note?: string;
}

export type NetworkRole = "lan" | "guest" | "iot" | "wan" | "legacy" | "management";

export const menu = (cfg: RosConfig | undefined, path: string): RosRecord[] => cfg?.menus[path] ?? [];

export const single = (cfg: RosConfig | undefined, path: string): RosRecord | undefined => cfg?.menus[path]?.[0];

export function prop(rec: RosRecord | undefined, key: string, fallback = ""): string {
  const v = rec?.[key];
  return v === undefined || v === "" ? fallback : v;
}

export const isTrue = (v: string | undefined) => v === "yes" || v === "true";

export const enabled = (rec: RosRecord | undefined) => !!rec && !isTrue(rec.disabled);

export const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

/** Keys that must never leave the parser. */
const SENSITIVE = /(passphrase|password|secret|key|psk|token)$/i;

export function scrub(rec: RosRecord): RosRecord {
  for (const k of Object.keys(rec)) if (SENSITIVE.test(k)) rec[k] = "<hidden>";
  return rec;
}

// ---------------------------------------------------------------------------
// /export parser

/** Parse a RouterOS `/export` script (any v7 export, terse or wrapped). */
export function parseExport(text: string): RosConfig {
  const cfg: RosConfig = { meta: {}, menus: {} };
  const lines = joinContinuations(text);
  let path = "";
  let notes: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      const body = line.replace(/^#\s?/, "");
      if (!path) readHeader(body, cfg.meta);
      else notes.push(body);
      continue;
    }

    if (line.startsWith("/")) {
      // "/interface wifi channel" or "/ip dns set servers=..." (menu with inline command)
      const tokens = tokenize(line);
      const menuParts: string[] = [];
      let i = 0;
      for (; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (i > 0 && (t.includes("=") || COMMANDS.has(t) || t.startsWith("["))) break;
        menuParts.push(t.replace(/^\//, ""));
      }
      path = "/" + menuParts.join("/").replace(/\s+/g, "/");
      notes = [];
      if (i < tokens.length) {
        applyCommand(cfg, path, tokens.slice(i), notes);
        notes = [];
      }
      continue;
    }

    if (!path) continue;
    applyCommand(cfg, path, tokenize(line), notes);
    notes = [];
  }
  return cfg;
}

const COMMANDS = new Set(["add", "set", "remove", "enable", "disable"]);

function readHeader(body: string, meta: RosMeta) {
  const by = body.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) by RouterOS (\S+)/);
  if (by) {
    meta.exportedAt = by[1];
    meta.version = by[2];
    return;
  }
  const kv = body.match(/^([a-z ]+?)\s*=\s*(.+)$/i);
  if (!kv) return;
  const key = kv[1]!.trim().toLowerCase();
  if (key === "model") meta.model = kv[2]!.trim();
  if (key === "software id") meta.softwareId = kv[2]!.trim();
  // Serial numbers are deliberately dropped.
}

function joinContinuations(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const piece = buf ? line.replace(/^\s+/, "") : line;
    if (/\\$/.test(piece) && !/\\\\$/.test(piece)) {
      buf += piece.slice(0, -1);
    } else {
      out.push(buf + piece);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Split on whitespace, keeping "quoted strings" and [ bracketed expressions ] together. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < line.length) cur += line[++i];
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') {
      quote = true;
      cur += c;
    } else if (c === "[") {
      depth++;
      cur += c;
    } else if (c === "]") {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (/\s/.test(c) && depth === 0) {
      if (cur) tokens.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Decode a RouterOS value: strip quotes, resolve \" \\ \n and \XX byte escapes (UTF-8). */
export function unquote(v: string): string {
  if (!(v.startsWith('"') && v.endsWith('"') && v.length >= 2)) return v;
  const body = v.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\" && i + 1 < body.length) {
      const n = body[i + 1]!;
      const hex = body.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "_": " " };
      bytes.push(...enc.encode(map[n] ?? n));
      i += 1;
      continue;
    }
    bytes.push(...enc.encode(c));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function parseProps(tokens: string[]): RosRecord {
  const rec: RosRecord = {};
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    rec[t.slice(0, eq)] = unquote(t.slice(eq + 1));
  }
  return scrub(rec);
}

function applyCommand(cfg: RosConfig, path: string, tokens: string[], notes: string[]) {
  const [cmd, ...rest] = tokens;
  const items = (cfg.menus[path] ??= []);
  const withNotes = (rec: RosRecord) => {
    if (notes.length) rec._notes = [rec._notes, ...notes].filter(Boolean).join("\n");
    return rec;
  };

  if (cmd === "add") {
    items.push(withNotes(parseProps(rest)));
    return;
  }
  if (cmd !== "set") return;

  const first = rest[0];
  if (first?.startsWith("[")) {
    // set [ find default-name=ether1 ] ...   |   set [ find default=yes ] ...
    const inner = first.replace(/^\[\s*find\s*/, "").replace(/\s*\]$/, "");
    const where = parseProps(tokenize(inner));
    const props = parseProps(rest.slice(1));
    let target = items.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    if (!target) {
      target = { ...where };
      if (where["default-name"] && !props.name) target.name = where["default-name"];
      items.push(target);
    }
    Object.assign(target, props);
    withNotes(target);
    return;
  }
  if (first && !first.includes("=")) {
    // set ftp disabled=yes  (item addressed by name)
    const props = parseProps(rest.slice(1));
    let target = items.find((r) => r.name === first);
    if (!target) items.push((target = { name: first }));
    Object.assign(target, props);
    withNotes(target);
    return;
  }
  // Singleton menu: set enabled=yes
  const props = parseProps(rest);
  if (!items[0]) items.push({});
  Object.assign(items[0]!, props);
  withNotes(items[0]!);
}
