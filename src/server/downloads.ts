// Databases Stribog downloads into its data directory (network owners, address countries):
// fetched in the background when missing or old, loaded into memory once, and used only when
// ready, so nothing waits on them.

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Kept<T> {
  path: string;
  db?: T;
  loading?: Promise<void>;
  fetching?: Promise<void>;
}

const G = globalThis as { __stribogDownloads?: Map<string, Kept<unknown>> };

export interface Downloaded<T> {
  /** A name for this database, unique in the process. */
  key: string;
  path: string;
  refreshMs: number;
  /** The file's bytes; the default checks they are gzip. */
  download: (fetchImpl: typeof fetch) => Promise<Buffer>;
  load: (path: string) => Promise<T>;
}

/** The database if it is in memory; otherwise starts loading or downloading it. */
export function keptDb<T>(d: Downloaded<T>, fetchImpl: typeof fetch = fetch): T | undefined {
  const all = (G.__stribogDownloads ??= new Map());
  let s = all.get(d.key) as Kept<T> | undefined;
  if (!s || s.path !== d.path) all.set(d.key, (s = { path: d.path }));
  const st = s;
  const fresh = existsSync(d.path) && Date.now() - statSync(d.path).mtimeMs < d.refreshMs;
  // STRIBOG_NO_DOWNLOADS=1 keeps Stribog off the internet (tests, air-gapped setups); a database already on disk still works.
  if (!fresh && !st.fetching && (!process.env.STRIBOG_NO_DOWNLOADS || fetchImpl !== fetch))
    st.fetching = d
      .download(fetchImpl)
      .then((buf) => {
        save(d.path, buf);
        st.db = undefined;
        st.loading = undefined;
      })
      .catch(() => {})
      .finally(() => (st.fetching = undefined));
  if (!st.db && !st.loading && existsSync(d.path))
    st.loading = d
      .load(d.path)
      .then((db) => void (st.db = db))
      .catch(() => {})
      .finally(() => (st.loading = undefined));
  return st.db;
}

/** Wait for a load or download in progress (tests, the first lookup after start). */
export async function keptDbReady<T>(d: Downloaded<T>, fetchImpl?: typeof fetch): Promise<T | undefined> {
  keptDb(d, fetchImpl);
  const s = () => G.__stribogDownloads?.get(d.key) as Kept<T> | undefined;
  await s()?.fetching;
  keptDb(d, fetchImpl);
  await s()?.loading;
  return s()?.db;
}

/** A gzip file's bytes, or an error naming what went wrong. */
export async function fetchGzip(url: string, fetchImpl: typeof fetch, what: string): Promise<Buffer> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20 || buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error(`${what}: not a gzip file`);
  return buf;
}

function save(path: string, buf: Buffer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, buf, { mode: 0o600 });
  renameSync(tmp, path);
}
