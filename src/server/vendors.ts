// Who made a device's network interface, from the IEEE registry of MAC address prefixes (public
// data: MA-L, MA-M and MA-S assignments). Downloaded weekly into the data directory and looked
// up here; no address a device uses leaves this machine for it.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normMac } from "../core/net.ts";

export const OUI_URLS = [
  "https://standards-oui.ieee.org/oui/oui.csv",
  "https://standards-oui.ieee.org/oui28/mam.csv",
  "https://standards-oui.ieee.org/oui36/oui36.csv",
];
const REFRESH_MS = 7 * 86_400_000;

/** Prefixes (hex digits, 6, 7 or 9 of them) to organisation names; the longest match wins. */
export class VendorDb {
  constructor(private byPrefix: Map<string, string>) {}

  get size() {
    return this.byPrefix.size;
  }

  static load(path: string): VendorDb {
    const map = new Map<string, string>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const i = line.indexOf("\t");
      if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
    }
    return new VendorDb(map);
  }

  lookup = (mac: string): string | undefined => {
    const hex = normMac(mac).replace(/:/g, "");
    if (hex.length !== 12) return undefined;
    return this.byPrefix.get(hex.slice(0, 9)) ?? this.byPrefix.get(hex.slice(0, 7)) ?? this.byPrefix.get(hex.slice(0, 6));
  };
}

/**
 * Assignment → organisation from one IEEE CSV ("Registry,Assignment,Organization Name,…").
 * Blocks the IEEE keeps or sub-assigns, and private ones, carry no maker and are left out.
 */
export function parseOuiCsv(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const row of csvRows(text)) {
    const [registry, assignment, org] = row;
    if (!registry || registry === "Registry" || !assignment || !org) continue;
    const name = org.replace(/\s+/g, " ").trim();
    if (!/^[0-9A-F]{6,9}$/i.test(assignment) || !name || /^(private|ieee registration authority)$/i.test(name)) continue;
    out.push([assignment.toUpperCase(), name]);
  }
  return out;
}

/** CSV with quoted fields ("" for a quote), one record per row. */
function* csvRows(text: string): Generator<string[]> {
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      yield row;
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) yield [...row, field];
}

// ---- the registry on disk -------------------------------------------------------------

const G = globalThis as { __stribogVendors?: { path: string; db?: VendorDb; at?: number; fetching?: Promise<void> } };

/**
 * The registry, if it is ready. Starts downloading it when it is missing or older than a week;
 * until then devices go without a registered maker.
 */
export function vendorDb(dataDir: string, fetchImpl: typeof fetch = fetch): VendorDb | undefined {
  const path = join(dataDir, "vendors", "oui.tsv");
  if (G.__stribogVendors?.path !== path) G.__stribogVendors = { path };
  const s = G.__stribogVendors;
  const mtime = existsSync(path) ? statSync(path).mtimeMs : undefined;
  // STRIBOG_NO_DOWNLOADS=1 keeps Stribog off the internet (tests, air-gapped setups); a registry already on disk still works.
  if ((mtime === undefined || Date.now() - mtime > REFRESH_MS) && !s.fetching && (!process.env.STRIBOG_NO_DOWNLOADS || fetchImpl !== fetch))
    s.fetching = download(path, fetchImpl)
      .catch(() => {})
      .finally(() => (s.fetching = undefined));
  // Reload when the file on disk is newer than what is in memory (a finished download).
  if (mtime !== undefined && (!s.db || s.at !== mtime)) {
    try {
      s.db = VendorDb.load(path);
      s.at = mtime;
    } catch {
      s.db = undefined;
    }
  }
  return s.db;
}

/** Wait for a download in progress (tests, the first lookup after start). */
export async function vendorReady(dataDir: string, fetchImpl?: typeof fetch): Promise<VendorDb | undefined> {
  vendorDb(dataDir, fetchImpl);
  await G.__stribogVendors?.fetching;
  return vendorDb(dataDir, fetchImpl);
}

async function download(path: string, fetchImpl: typeof fetch) {
  const all: [string, string][] = [];
  for (const url of OUI_URLS) {
    const res = await fetchImpl(url, { headers: { "user-agent": "Stribog (home network inspector)" } });
    if (!res.ok) throw new Error(`MAC registry: HTTP ${res.status} for ${url}`);
    all.push(...parseOuiCsv(await res.text()));
  }
  // A truncated or changed download must not replace a good registry.
  if (all.length < 1000) throw new Error("MAC registry: too few assignments");
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, all.map(([p, n]) => `${p}\t${n.replace(/[\t\n]/g, " ")}`).join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
