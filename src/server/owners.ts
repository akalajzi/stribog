// Who is behind an internet address. Router data cannot say, so Stribog uses:
// - an offline ASN database (iptoasn.com, public domain), downloaded weekly into the data
//   directory: no address a device talks to leaves this machine for it;
// - reverse DNS through the system's own resolver, which already sees every name lookup;
// - RDAP (registry "whois"), only when someone asks about one address.

import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

export interface Owner {
  asn: number;
  /** The organisation, e.g. "Apple Inc.". */
  name: string;
  /** The network's handle, e.g. "APPLE-ENGINEERING". */
  handle?: string;
  country?: string;
}

export const ASN_URL = "https://iptoasn.com/data/ip2asn-v4.tsv.gz";
const REFRESH_MS = 7 * 86_400_000;

const ipNum = (ip: string) => {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((x) => x >= 0 && x <= 255) ? ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]! : undefined;
};

/** "APPLE-ENGINEERING - Apple Inc." → handle and organisation. */
export function splitDescription(desc: string): { handle?: string; name: string } {
  const i = desc.indexOf(" - ");
  if (i > 0) return { handle: desc.slice(0, i), name: desc.slice(i + 3) };
  // "ADGUARD AdGuard Software Limited": an all-caps handle, then the organisation.
  const m = /^([A-Z0-9][A-Z0-9_-]+)\s+(.*[a-z].*)$/.exec(desc);
  return m ? { handle: m[1], name: m[2]! } : { name: desc };
}

/** Address ranges sorted by start, each pointing at its owner. Lookups are a binary search. */
export class AsnDb {
  constructor(
    private starts: Uint32Array,
    private ends: Uint32Array,
    private idx: Int32Array,
    private owners: Owner[],
  ) {}

  get size() {
    return this.starts.length;
  }

  static async load(path: string): Promise<AsnDb> {
    const starts: number[] = [];
    const ends: number[] = [];
    const idx: number[] = [];
    const owners: Owner[] = [];
    const byKey = new Map<string, number>();
    const input = path.endsWith(".gz") ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const [a, b, asn, country, desc] = line.split("\t");
      const s = ipNum(a ?? "");
      const e = ipNum(b ?? "");
      if (s === undefined || e === undefined || !asn || asn === "0") continue;
      const key = `${asn}|${country}|${desc}`;
      let k = byKey.get(key);
      if (k === undefined) {
        const { handle, name } = splitDescription(desc ?? "");
        owners.push({ asn: Number(asn), name: name || `AS${asn}`, handle, country: country && country !== "None" ? country : undefined });
        byKey.set(key, (k = owners.length - 1));
      }
      starts.push(s);
      ends.push(e);
      idx.push(k);
    }
    return new AsnDb(Uint32Array.from(starts), Uint32Array.from(ends), Int32Array.from(idx), owners);
  }

  lookup(ip: string): Owner | undefined {
    const n = ipNum(ip);
    if (n === undefined) return undefined;
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! <= n) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi >= 0 && n <= this.ends[hi]! ? this.owners[this.idx[hi]!] : undefined;
  }
}

// ---- the database on disk ---------------------------------------------------------

const G = globalThis as { __stribogAsn?: { path: string; db?: AsnDb; loading?: Promise<void>; fetching?: Promise<void> } };

/**
 * The ASN database, if it is ready. Starts loading it from the data directory, and downloading
 * it when it is missing or older than a week; until then callers go without owners.
 */
export function asnDb(dataDir: string, fetchImpl: typeof fetch = fetch): AsnDb | undefined {
  const path = join(dataDir, "asn", "ip2asn-v4.tsv.gz");
  const st = (G.__stribogAsn ??= { path });
  if (st.path !== path) G.__stribogAsn = { path };
  const s = G.__stribogAsn!;
  const fresh = existsSync(path) && Date.now() - statSync(path).mtimeMs < REFRESH_MS;
  // STRIBOG_NO_DOWNLOADS=1 keeps Stribog off the internet (tests, air-gapped setups); a database already on disk still works.
  if (!fresh && !s.fetching && (!process.env.STRIBOG_NO_DOWNLOADS || fetchImpl !== fetch))
    s.fetching = download(path, fetchImpl)
      .then(() => {
        s.db = undefined;
        s.loading = undefined;
      })
      .catch(() => {})
      .finally(() => (s.fetching = undefined));
  if (!s.db && !s.loading && existsSync(path))
    s.loading = AsnDb.load(path)
      .then((db) => void (s.db = db))
      .catch(() => {})
      .finally(() => (s.loading = undefined));
  return s.db;
}

/** Wait for a load or download in progress (tests, the first lookup after start). */
export async function asnReady(dataDir: string, fetchImpl?: typeof fetch): Promise<AsnDb | undefined> {
  asnDb(dataDir, fetchImpl);
  await G.__stribogAsn?.fetching;
  asnDb(dataDir, fetchImpl);
  await G.__stribogAsn?.loading;
  return G.__stribogAsn?.db;
}

async function download(path: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(ASN_URL);
  if (!res.ok) throw new Error(`ASN database: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20 || buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error("ASN database: not a gzip file");
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, buf, { mode: 0o600 });
  renameSync(tmp, path);
}

// ---- reverse DNS -----------------------------------------------------------------

const ptrCache = new Map<string, { name?: string; at: number }>();

/** The address's reverse-DNS name, through the system resolver; undefined when there is none or it is slow. */
export async function reverseName(ip: string, timeoutMs = 800): Promise<string | undefined> {
  const hit = ptrCache.get(ip);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.name;
  const name = await Promise.race([
    dns.reverse(ip).then(
      (n) => n[0],
      () => undefined,
    ),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs)),
  ]);
  ptrCache.set(ip, { name, at: Date.now() });
  return name;
}

// ---- RDAP, on request ---------------------------------------------------------------

export interface Registration {
  network?: string;
  range?: string;
  organisation?: string;
  country?: string;
  abuse?: string;
  registry?: string;
  link: string;
}

/** The registry's record for one address (RDAP via rdap.org, which redirects to the right registry). */
export async function rdap(ip: string, fetchImpl: typeof fetch = fetch): Promise<Registration> {
  const link = `https://rdap.org/ip/${encodeURIComponent(ip)}`;
  // rdap.org refuses the default Node user agent.
  const res = await fetchImpl(link, { headers: { accept: "application/rdap+json", "user-agent": "Stribog (home network inspector)" }, redirect: "follow" });
  if (!res.ok) throw new Error(`The registry answered HTTP ${res.status}.`);
  const j = (await res.json()) as {
    name?: string;
    startAddress?: string;
    endAddress?: string;
    country?: string;
    port43?: string;
    entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]]; entities?: unknown[] }[];
  };
  const vcard = (e: NonNullable<typeof j.entities>[number], field: string) => e.vcardArray?.[1]?.find((v) => v[0] === field)?.[3];
  const all = flatten(j.entities ?? []);
  // The registrant organisation ("kind: org"); never maintainers' handles or people's names.
  const registrants = all.filter((e) => e.roles?.includes("registrant"));
  const org = registrants.find((e) => vcard(e, "kind") === "org") ?? registrants.find((e) => vcard(e, "kind") !== "individual" && vcard(e, "kind") !== undefined);
  const abuse = all.find((e) => e.roles?.includes("abuse"));
  return {
    network: j.name,
    range: j.startAddress && j.endAddress ? `${j.startAddress} – ${j.endAddress}` : undefined,
    organisation: org ? (vcard(org, "fn") as string | undefined) : undefined,
    country: j.country,
    abuse: abuse ? (vcard(abuse, "email") as string | undefined) : undefined,
    registry: j.port43,
    link,
  };
}

function flatten<T extends { entities?: unknown[] }>(es: T[]): T[] {
  return es.flatMap((e) => [e, ...flatten((e.entities ?? []) as T[])]);
}
