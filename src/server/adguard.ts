// AdGuard Home as an optional source: which names each device looks up, from its query log over
// its HTTP API. Connected from Settings; the password stays in this process's memory, like the
// router's, and is gone when Stribog restarts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidateUrls } from "./session.ts";

export interface AdGuardLogin {
  url: string;
  user: string;
  password: string;
  encrypted: boolean;
  version?: string;
}

/** One DNS question a device asked, and what it was told. */
export interface Lookup {
  time: number;
  client: string;
  name: string;
  type: string;
  /** Refused by a block list, safe browsing, parental control or a blocked service. */
  blocked: boolean;
  /** Addresses in the answer (A and AAAA). */
  answers: string[];
  /** Names the answer passed through on the way (CNAME), in order. */
  via?: string[];
}

/** Lookups of one domain (example.com and its subdomains) by one device. */
export interface DomainUse {
  domain: string;
  /** The names asked for, most asked first. */
  names: string[];
  count: number;
  blocked: number;
  last: string;
}

/** What a device looked up over a period, for the device's details. */
export interface DnsUse {
  source: string;
  from: number;
  to: number;
  total: number;
  blocked: number;
  domains: DomainUse[];
  /** More lookups than Stribog reads at once: the oldest are left out. */
  truncated?: boolean;
  /** How long the DNS server keeps its log, when it says. */
  keptMs?: number;
  /** The server hides client addresses in its log, so lookups cannot be told apart by device. */
  anonymised?: boolean;
  error?: string;
}

/** Where lookups come from: AdGuard Home, or the demo's sample log. */
export interface DnsLog {
  source: string;
  lookups(since: number, o?: { client?: string; max?: number }): Promise<{ items: Lookup[]; truncated: boolean }>;
  config(): Promise<{ keptMs?: number; anonymised?: boolean }>;
}

export class AdGuardError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface RawItem {
  time?: string;
  client?: string;
  question?: { name?: string; unicode_name?: string; type?: string };
  reason?: string;
  answer?: { type?: string; value?: string }[];
}

const BLOCKED = new Set(["FilteredBlackList", "FilteredSafeBrowsing", "FilteredParental", "FilteredInvalid", "FilteredBlockedService"]);

export function toLookup(r: RawItem): Lookup | undefined {
  const time = Date.parse(r.time ?? "");
  const name = (r.question?.unicode_name || r.question?.name || "").replace(/\.$/, "").toLowerCase();
  if (!Number.isFinite(time) || !name || !r.client) return undefined;
  const answers = (r.answer ?? []).filter((a) => (a.type === "A" || a.type === "AAAA") && a.value).map((a) => a.value!);
  const via = (r.answer ?? []).filter((a) => a.type === "CNAME" && a.value).map((a) => a.value!.replace(/\.$/, "").toLowerCase());
  return { time, client: r.client, name, type: r.question?.type ?? "", blocked: BLOCKED.has(r.reason ?? ""), answers, ...(via.length ? { via } : {}) };
}

export class AdGuard implements DnsLog {
  readonly source = "AdGuard Home";
  constructor(
    readonly login: AdGuardLogin,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)]));
    const res = await this.fetchImpl(`${this.login.url}/control${path}${q.size ? `?${q}` : ""}`, {
      headers: { authorization: `Basic ${Buffer.from(`${this.login.user}:${this.login.password}`).toString("base64")}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) throw new AdGuardError("AdGuard Home did not accept that user name and password.", 401);
    if (!res.ok) throw new AdGuardError(`AdGuard Home answered HTTP ${res.status} for ${path}.`, 502);
    return (await res.json()) as T;
  }

  async status(): Promise<{ version?: string }> {
    const s = await this.get<{ version?: unknown; dns_addresses?: unknown }>("/status");
    if (!Array.isArray(s.dns_addresses) && typeof s.version !== "string") throw new AdGuardError("That answers, but not as AdGuard Home.", 502);
    return { version: typeof s.version === "string" ? s.version : undefined };
  }

  async config(): Promise<{ keptMs?: number; anonymised?: boolean }> {
    const c = await this.get<{ interval?: number; anonymize_client_ip?: boolean }>("/querylog/config").catch(() => ({}) as { interval?: number; anonymize_client_ip?: boolean });
    return { keptMs: typeof c.interval === "number" ? c.interval : undefined, anonymised: c.anonymize_client_ip || undefined };
  }

  /** Lookups newest first back to `since`, of one client when given (matched exactly), at most `max`. */
  async lookups(since: number, o: { client?: string; max?: number } = {}): Promise<{ items: Lookup[]; truncated: boolean }> {
    const max = o.max ?? 5000;
    const items: Lookup[] = [];
    let olderThan: string | undefined;
    // Quotes make AdGuard match the client exactly, not every address that starts the same.
    const search = o.client ? `"${o.client}"` : undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.get<{ data?: RawItem[]; oldest?: string }>("/querylog", { limit: 1000, older_than: olderThan, search });
      const data = r.data ?? [];
      for (const raw of data) {
        const l = toLookup(raw);
        if (!l) continue;
        if (l.time < since) return { items, truncated: false };
        if (o.client && l.client !== o.client) continue;
        items.push(l);
        if (items.length >= max) return { items, truncated: true };
      }
      if (!data.length || !r.oldest || r.oldest === olderThan) break;
      olderThan = r.oldest;
    }
    return { items, truncated: false };
  }
}

/** Find AdGuard Home at an address and check the user name and password. */
export async function connectAdGuard(address: string, user: string, password: string, fetchImpl: typeof fetch = fetch): Promise<AdGuardLogin> {
  const urls = candidateUrls(address);
  if (!urls.length) throw new AdGuardError("Enter AdGuard Home's address.", 400);
  if (!user) throw new AdGuardError("Enter a user name.", 400);
  let last: AdGuardError | undefined;
  for (const url of urls) {
    const login: AdGuardLogin = { url, user, password, encrypted: url.startsWith("https://") };
    try {
      const { version } = await new AdGuard(login, fetchImpl).status();
      return { ...login, version };
    } catch (err) {
      // A refused password stops at once, so it is never retried over plain http.
      if (err instanceof AdGuardError && err.status === 401) throw err;
      if (err instanceof AdGuardError) last = err;
    }
  }
  throw last ?? new AdGuardError(`Could not reach AdGuard Home at ${address.trim()}. Check the address (the one its web page opens at).`, 502);
}

// ---- the connection in use ------------------------------------------------------------

/** Answers each device got: client → address → names asked, newest first. Kept for a day. */
type NameBook = Map<string, Map<string, { names: string[]; at: number }>>;
const G = globalThis as { __stribogAdGuard?: { client: AdGuard; book: NameBook; readTo?: number; readAt?: number; error?: string } };

export function adguard(): AdGuard | undefined {
  return G.__stribogAdGuard?.client;
}

export function adguardError(): string | undefined {
  return G.__stribogAdGuard?.error;
}

export function setAdGuard(login: AdGuardLogin | undefined, fetchImpl?: typeof fetch) {
  G.__stribogAdGuard = login ? { client: new AdGuard(login, fetchImpl), book: new Map() } : undefined;
}

/** Add lookups to a name book: which names pointed a device at which address. */
export function addToBook(book: NameBook, items: Lookup[]) {
  for (const l of items) {
    if (l.blocked) continue;
    const mine = book.get(l.client) ?? new Map();
    book.set(l.client, mine);
    // The name asked for first, then the names the answer went through, as the router's cache gives them.
    const chain = [l.name, ...(l.via ?? [])];
    for (const ip of l.answers) {
      const e = mine.get(ip);
      if (!e) mine.set(ip, { names: [...new Set(chain)], at: l.time });
      else {
        for (const n of chain) if (!e.names.includes(n)) e.names.push(n);
        e.at = Math.max(e.at, l.time);
      }
    }
  }
}

/**
 * Bring the name book up to date (at most every 20 seconds) and give each device's names by
 * address. Without AdGuard Home, or when it cannot be read, an empty book.
 */
export async function recentNames(now = Date.now()): Promise<(client: string) => Map<string, string[]>> {
  const s = G.__stribogAdGuard;
  if (!s) return () => new Map();
  if (!s.readAt || now - s.readAt > 20_000) {
    s.readAt = now;
    try {
      const since = Math.max(now - 6 * 3600_000, (s.readTo ?? 0) - 60_000);
      const { items } = await s.client.lookups(since, { max: 20_000 });
      addToBook(s.book, items);
      s.readTo = items.length ? Math.max(...items.map((l) => l.time)) : (s.readTo ?? now);
      s.error = undefined;
      for (const [, mine] of s.book) for (const [ip, e] of mine) if (now - e.at > 86_400_000) mine.delete(ip);
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
    }
  }
  return (client) => new Map([...(s.book.get(client) ?? [])].map(([ip, e]) => [ip, e.names]));
}

/**
 * The router's names by address, overridden by what the device itself was told: the router's
 * cache is everyone's lookups, the DNS server's log is this device's.
 */
export function withNames(router: Map<string, string[]>, own: Map<string, string[]>): Map<string, string[]> {
  if (!own.size) return router;
  const out = new Map(router);
  for (const [ip, names] of own) out.set(ip, names);
  return out;
}

// ---- what a device looked up ------------------------------------------------------------

const TWO_PART = /^(co|com|net|org|gov|ac|edu|ne|or|go|gob|nic|ltd|plc)$/;

/** The registered domain a name belongs to: video.cdn.example.co.uk → example.co.uk. A guess from the shape of the name. */
export function baseDomain(name: string): string {
  const labels = name.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const take = labels.at(-1)!.length === 2 && TWO_PART.test(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Lookups as domains, most looked up first. Reverse lookups (who is this address) are left out. */
export function summarise(items: Lookup[]): { total: number; blocked: number; domains: DomainUse[] } {
  const by = new Map<string, { names: Map<string, number>; count: number; blocked: number; last: number }>();
  let total = 0;
  let blocked = 0;
  for (const l of items) {
    if (/\.(in-addr|ip6)\.arpa$/.test(l.name)) continue;
    total++;
    if (l.blocked) blocked++;
    const key = baseDomain(l.name);
    const d = by.get(key) ?? { names: new Map(), count: 0, blocked: 0, last: 0 };
    by.set(key, d);
    d.count++;
    if (l.blocked) d.blocked++;
    d.last = Math.max(d.last, l.time);
    d.names.set(l.name, (d.names.get(l.name) ?? 0) + 1);
  }
  const domains = [...by].map(([domain, d]) => ({
    domain,
    names: [...d.names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n),
    count: d.count,
    blocked: d.blocked,
    last: new Date(d.last).toISOString(),
  }));
  return { total, blocked, domains: domains.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)) };
}

/** What a device's addresses looked up since `from`, merged, plus the names behind each address it was given. */
export async function deviceLookups(log: DnsLog, ips: string[], from: number, to: number): Promise<{ use: DnsUse; names: Map<string, string[]> }> {
  const base: DnsUse = { source: log.source, from, to, total: 0, blocked: 0, domains: [] };
  try {
    const [cfg, ...per] = await Promise.all([log.config(), ...ips.map((ip) => log.lookups(from, { client: ip, max: 5000 }))]);
    const items = per.flatMap((p) => p.items).filter((l) => l.time <= to);
    const book: NameBook = new Map();
    addToBook(book, items);
    const names = new Map<string, string[]>();
    for (const [, mine] of book) for (const [ip, e] of mine) names.set(ip, [...new Set([...(names.get(ip) ?? []), ...e.names])]);
    const s = summarise(items);
    return { use: { ...base, ...s, domains: s.domains.slice(0, 200), truncated: per.some((p) => p.truncated) || undefined, ...cfg }, names };
  } catch (err) {
    return { use: { ...base, error: err instanceof Error ? err.message : String(err) }, names: new Map() };
  }
}

// ---- the demo's sample log ------------------------------------------------------------------

const DEMO_LOG = resolve(import.meta.dirname, "../../fixtures/demo/adguard-querylog.json");
let demoItems: Lookup[] | undefined;

/** The demo network's AdGuard Home: a fixed sample of its query log, shaped like the API's. */
export const demoDnsLog: DnsLog = {
  source: "AdGuard Home (sample)",
  async lookups(since, o = {}) {
    demoItems ??= (JSON.parse(readFileSync(DEMO_LOG, "utf8")) as { data: RawItem[] }).data.flatMap((r) => toLookup(r) ?? []);
    const items = demoItems.filter((l) => l.time >= since && (!o.client || l.client === o.client));
    return { items: items.slice(0, o.max ?? 5000), truncated: items.length > (o.max ?? 5000) };
  },
  async config() {
    return { keptMs: 7 * 86_400_000 };
  },
};
