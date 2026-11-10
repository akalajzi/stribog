// Which country an internet address is in, roughly. Router data cannot say, so Stribog uses
// DB-IP's free "IP to Country Lite" database (CC BY 4.0, https://db-ip.com), downloaded monthly
// into the data directory: no address a device talks to leaves this machine for it.
//
// It is a guess: a geolocation database names one country per address range, and big services
// answer from many places under the same addresses.

import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { fetchGzip, keptDb, keptDbReady, type Downloaded } from "./downloads.ts";
import { ipNum } from "./owners.ts";

/** DB-IP publishes a new file each month, named after it. */
export const countryUrl = (d: Date) => `https://download.db-ip.com/free/dbip-country-lite-${d.toISOString().slice(0, 7)}.csv.gz`;
export const COUNTRY_CREDIT = { text: "IP geolocation by DB-IP", url: "https://db-ip.com" };
const REFRESH_MS = 14 * 86_400_000;

/** Address ranges sorted by start, each with its country (ISO 3166 alpha-2). IPv4 only. */
export class CountryDb {
  constructor(
    private starts: Uint32Array,
    private ends: Uint32Array,
    private idx: Uint16Array,
    private codes: string[],
  ) {}

  get size() {
    return this.starts.length;
  }

  /** DB-IP's CSV, gzipped or not: "1.0.0.0,1.0.0.255,AU". Neighbouring ranges in one country become one. */
  static async load(path: string): Promise<CountryDb> {
    const starts: number[] = [];
    const ends: number[] = [];
    const idx: number[] = [];
    const codes: string[] = [];
    const byCode = new Map<string, number>();
    const input = path.endsWith(".gz") ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const [a, b, cc] = line.split(",");
      const s = ipNum(a ?? "");
      const e = ipNum(b ?? "");
      const code = cc?.trim().toUpperCase();
      if (s === undefined || e === undefined || !code || !/^[A-Z]{2}$/.test(code) || code === "ZZ") continue;
      let k = byCode.get(code);
      if (k === undefined) byCode.set(code, (k = codes.push(code) - 1));
      const last = starts.length - 1;
      if (last >= 0 && idx[last] === k && ends[last]! + 1 === s) ends[last] = e;
      else {
        starts.push(s);
        ends.push(e);
        idx.push(k);
      }
    }
    return new CountryDb(Uint32Array.from(starts), Uint32Array.from(ends), Uint16Array.from(idx), codes);
  }

  lookup(ip: string): string | undefined {
    const n = ipNum(ip);
    if (n === undefined) return undefined;
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! <= n) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi >= 0 && n <= this.ends[hi]! ? this.codes[this.idx[hi]!] : undefined;
  }
}

const countryFile = (dataDir: string): Downloaded<CountryDb> => ({
  key: "country",
  path: join(dataDir, "geo", "dbip-country-lite.csv.gz"),
  refreshMs: REFRESH_MS,
  // Early in a month this month's file may not be out yet: then last month's.
  download: async (f) => {
    const now = new Date();
    try {
      return await fetchGzip(countryUrl(now), f, "Country database");
    } catch {
      return fetchGzip(countryUrl(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), f, "Country database");
    }
  },
  load: CountryDb.load,
});

/** The country database, if it is ready; starts loading or downloading it otherwise. */
export const countryDb = (dataDir: string, fetchImpl?: typeof fetch): CountryDb | undefined => keptDb(countryFile(dataDir), fetchImpl);

/** Wait for a load or download in progress (tests, the first lookup after start). */
export const countryReady = (dataDir: string, fetchImpl?: typeof fetch): Promise<CountryDb | undefined> => keptDbReady(countryFile(dataDir), fetchImpl);
