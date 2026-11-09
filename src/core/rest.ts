// RouterOS v7 REST collector.
//
// Reads with GET for every menu and the `monitor ... once` commands (POST, but they only read).
// The web app signs in with the router's own user (usually admin); the CLI can use any user,
// including a read-only one. The REST API is served by `www-ssl`, and by `www` since 7.9.

import { liveRatesFrom, type LiveRates } from "./live.ts";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { scrub, type DeviceSnapshot, type RosRecord } from "./ros.ts";

export const CONFIG_PATHS = [
  "/system/identity",
  "/system/package/update",
  "/system/clock",
  "/system/ntp/client",
  "/system/ntp/server",
  "/system/ntp/client/servers",
  "/system/scheduler",
  "/interface/bridge",
  "/interface/bridge/port",
  "/interface/ethernet",
  "/interface/ethernet/poe",
  "/interface/vlan",
  "/interface/list",
  "/interface/list/member",
  "/interface/pppoe-client",
  "/interface/wifi",
  "/interface/wifi/configuration",
  "/interface/wifi/security",
  "/interface/wifi/channel",
  "/interface/wifi/datapath",
  "/interface/wifi/provisioning",
  "/interface/wifi/capsman",
  "/ip/address",
  "/ip/pool",
  "/ip/dhcp-client",
  "/ip/dhcp-server",
  "/ip/dhcp-server/network",
  "/ip/dhcp-server/lease",
  "/ip/dns",
  "/ip/dns/static",
  "/ip/firewall/filter",
  "/ip/firewall/nat",
  "/ip/service",
  "/ip/ssh",
  "/ip/neighbor/discovery-settings",
  "/tool/mac-server",
  "/tool/mac-server/mac-winbox",
  "/disk/settings",
  "/container",
  "/interface/veth",
  "/ipv6/nd",
];

/** State that changes by the minute: who is connected, links up or down. Read on every refresh. */
export const STATE_PATHS = ["/interface", "/ip/arp", "/interface/bridge/host", "/interface/wifi/registration-table", "/ip/dhcp-client", "/ip/dhcp-server/lease"];

/** State that changes slowly: neighbours, radio channels, access points joining. Read about once a minute. */
export const SLOW_PATHS = ["/ip/neighbor", "/interface/wifi/capsman/remote-cap", "/interface/wifi/radio"];

/** What never changes while the router runs. Read with the configuration. */
export const FIXED_PATHS = ["/system/routerboard"];

/**
 * Which parts a read refreshes. Configuration (some forty menus) changes when someone changes it,
 * so it is read at sign-in, on request and every few minutes; the rest is reused from `reuse`.
 */
export interface ReadPlan {
  reuse?: DeviceSnapshot;
  config?: boolean;
  slow?: boolean;
}

export interface RestOptions {
  url: string;
  user: string;
  password: string;
  /** Allow self-signed certificates (https only). */
  insecure?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type MonitorShape = "id-true" | "numbers-id-true" | "id-empty" | "numbers-name-empty";
/** Which monitor body each router accepted, by URL, so later reads go straight to it. */
const monitorShape = new Map<string, MonitorShape>();

export class AuthError extends Error {}
export class NotRouterOsError extends Error {}
export class NotFoundError extends Error {}

// RouterOS's web service allows 20 sessions by default and a snapshot asks for ~45 menus,
// so requests queue on a few kept-alive connections instead of all going out at once.
const MAX_SOCKETS = 4;
const agents = {
  http: new HttpAgent({ keepAlive: true, maxSockets: MAX_SOCKETS }),
  https: new HttpsAgent({ keepAlive: true, maxSockets: MAX_SOCKETS }),
  httpsInsecure: new HttpsAgent({ keepAlive: true, maxSockets: MAX_SOCKETS, rejectUnauthorized: false }),
};

/** A fetch() on node:http(s), so a self-signed router certificate is accepted for this router only, not process-wide. */
export function routerFetch(insecure = false): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input));
      const https = url.protocol === "https:";
      const body = init?.body ? String(init.body) : undefined;
      // A length, not chunked encoding: RouterOS's web server drops chunked request bodies.
      const headers = { ...(init?.headers as Record<string, string>), ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) };
      const req = (https ? httpsRequest : httpRequest)(
        url,
        {
          method: init?.method ?? "GET",
          headers,
          agent: https ? (insecure ? agents.httpsInsecure : agents.https) : agents.http,
          signal: init?.signal ?? undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            const status = res.statusCode ?? 502;
            resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status }));
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    })) as typeof fetch;
}

async function rowsOf(res: Response, what: string): Promise<RosRecord[]> {
  const text = await res.text();
  if (!text.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new NotRouterOsError(`${what}: the answer is not RouterOS JSON`);
  }
  const rows = Array.isArray(data) ? data : [data];
  return rows.map((r) => scrub(Object.fromEntries(Object.entries(r as object).map(([k, v]) => [k, String(v)])) as RosRecord));
}

/** RouterOS answers errors as {"error":400,"message":"Bad Request","detail":"..."}. */
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { message?: string; detail?: string };
    return [j.message, j.detail].filter(Boolean).join(": ") || text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

export class RouterOsRest {
  /** Why a menu came back empty, by "GET /path"; filled while reading. */
  readonly errors: Record<string, string> = {};

  constructor(private opt: RestOptions) {}

  get url() {
    return this.opt.url;
  }

  private async request<T>(method: string, path: string, body: unknown, handle: (res: Response) => Promise<T>): Promise<T> {
    const f = this.opt.fetchImpl ?? routerFetch(this.opt.insecure);
    const url = this.opt.url.replace(/\/$/, "") + "/rest" + path;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opt.timeoutMs ?? 8000);
    try {
      const res = await f(url, {
        method,
        signal: ctrl.signal,
        headers: {
          authorization: "Basic " + Buffer.from(`${this.opt.user}:${this.opt.password}`).toString("base64"),
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return await handle(res);
    } finally {
      clearTimeout(t);
    }
  }

  private call(method: "GET" | "POST", path: string, body?: unknown): Promise<RosRecord[]> {
    return this.request(method, path, body, async (res) => {
      if (res.status === 401 || res.status === 403) throw new AuthError(`${method} ${path}: HTTP ${res.status} (check the user and its policies)`);
      if (res.status === 404 || res.status === 400) {
        // Menu absent on this model or package. A 400 on a command we built ourselves is worth knowing about.
        if (res.status === 400 || method === "POST") this.errors[`${method} ${path}`] = `HTTP ${res.status}: ${await errorDetail(res)}`;
        return [];
      }
      if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}: ${await errorDetail(res)}`);
      return rowsOf(res, `${method} ${path}`);
    });
  }

  /**
   * A change to the router: PUT adds, PATCH sets, DELETE removes, POST runs a command. Anything
   * but success throws with the router's reason; 404 throws NotFoundError.
   */
  write(method: "PUT" | "PATCH" | "DELETE" | "POST", path: string, body?: unknown): Promise<RosRecord[]> {
    return this.request(method, path, body, async (res) => {
      if (res.status === 401) throw new AuthError(`${method} ${path}: HTTP 401 (check the user and its policies)`);
      if (res.status === 404) throw new NotFoundError(`${method} ${path}: no such item`);
      if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}: ${await errorDetail(res)}`);
      return rowsOf(res, `${method} ${path}`);
    });
  }

  /** A menu's items, or undefined when the router has no such menu. Errors other than that throw. */
  async list(path: string): Promise<RosRecord[] | undefined> {
    return this.request("GET", path, undefined, async (res) => {
      if (res.status === 401 || res.status === 403) throw new AuthError(`GET ${path}: HTTP ${res.status}`);
      if (res.status === 404 || res.status === 400) return undefined;
      if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}: ${await errorDetail(res)}`);
      return rowsOf(res, `GET ${path}`);
    });
  }

  get(path: string) {
    return this.call("GET", path);
  }

  /**
   * Check the login and that this is a RouterOS 7 REST API. Throws AuthError for a refused login,
   * NotRouterOsError when something answers but it is not RouterOS REST, and network errors as they come.
   */
  async probe(): Promise<{ identity?: string; version?: string; model?: string }> {
    const [res] = await this.call("GET", "/system/resource").catch((err: unknown) => {
      if (err instanceof Error && /HTTP \d/.test(err.message) && !(err instanceof AuthError)) throw new NotRouterOsError(err.message);
      throw err;
    });
    if (!res?.version) throw new NotRouterOsError("no /rest/system/resource");
    const [id] = await this.get("/system/identity").catch(() => []);
    return { identity: id?.name, version: res.version.split(" ")[0], model: res["board-name"] };
  }

  /**
   * `monitor ... once` for the given items of a menu. RouterOS versions disagree on the body:
   * the docs use `numbers` with `once: ""`, 7.21 answers that with "missing =.id=", and forum
   * reports have `.id` with `once: true` working. Try each shape until one returns rows, and
   * remember the winner per router. Each result row is tagged with the item's name.
   */
  async monitor(menuPath: string, items: RosRecord[]) {
    const list = items.filter((x) => x.name);
    if (!list.length) return [];
    const path = `${menuPath}/monitor`;
    const ids = list.every((x) => x[".id"]) ? list.map((x) => x[".id"]).join(",") : undefined;
    const names = list.map((x) => x.name).join(",");
    const shapes: Record<MonitorShape, Record<string, string> | undefined> = {
      "id-true": ids ? { ".id": ids, once: "true" } : undefined,
      "numbers-id-true": ids ? { numbers: ids, once: "true" } : undefined,
      "id-empty": ids ? { ".id": ids, once: "" } : undefined,
      "numbers-name-empty": { numbers: names, once: "" },
    };
    const known = monitorShape.get(this.opt.url);
    const order = (Object.keys(shapes) as MonitorShape[]).sort((a, b) => Number(b === known) - Number(a === known));
    const tried: string[] = [];
    for (const shape of order) {
      const body = shapes[shape];
      if (!body) continue;
      const rows = await this.call("POST", path, body);
      if (rows.length) {
        monitorShape.set(this.opt.url, shape);
        delete this.errors[`POST ${path}`];
        return rows.map((r, i) => ({ ...r, name: r.name ?? list[i]!.name! }));
      }
      tried.push(`${shape}: ${this.errors[`POST ${path}`] ?? "no rows"}`);
    }
    this.errors[`POST ${path}`] = tried.join(" | ");
    return [];
  }

  /**
   * Current throughput of the given interfaces: `/interface monitor-traffic … once`. Read-only.
   * Rows are tagged with the interface name.
   */
  async monitorTraffic(names: string[]) {
    if (!names.length) return [];
    const path = "/interface/monitor-traffic";
    let rows: RosRecord[] = [];
    for (const once of ["", "true"]) {
      rows = await this.call("POST", path, { interface: names.join(","), once });
      if (rows.length) break;
    }
    if (rows.length) delete this.errors[`POST ${path}`];
    return rows.map((r, i) => ({ ...r, name: r.name ?? names[i]! }));
  }

  /**
   * The connection tracking table: who talks to whom, on which ports, how much. Read on demand
   * (it can be large), trimmed to the fields Stribog uses. Only routed traffic is tracked.
   */
  async connections(): Promise<RosRecord[]> {
    const fields = [".id", "protocol", "src-address", "dst-address", "reply-src-address", "reply-dst-address", "src-port", "dst-port", "reply-src-port", "reply-dst-port", "orig-bytes", "repl-bytes", "orig-packets", "repl-packets", "tcp-state", "timeout", "connection-type", "fasttrack"];
    const rows = await this.call("POST", "/ip/firewall/connection/print", { ".proplist": fields }).catch(() => [] as RosRecord[]);
    return rows.length ? rows : this.get("/ip/firewall/connection");
  }

  /** Just the numbers that change by the second: port throughput, Wi-Fi clients, the router's load. */
  async rates(ports: string[]): Promise<LiveRates> {
    const [traffic, reg, res] = await Promise.all([
      this.monitorTraffic(ports).catch(() => [] as RosRecord[]),
      this.get("/interface/wifi/registration-table").catch(() => [] as RosRecord[]),
      this.get("/system/resource").catch(() => [] as RosRecord[]),
    ]);
    return liveRatesFrom(traffic, reg, res[0]);
  }

  /**
   * A few pings from the router to one address: `/ping`, which sends packets and changes
   * nothing. A user needs the `test` policy for it; without one the answer is empty.
   */
  ping(address: string, count = 3): Promise<RosRecord[]> {
    return this.call("POST", "/ping", { address, count: String(count) });
  }

  /**
   * Ask the router to check MikroTik's server for a newer RouterOS on its channel. Changes no
   * settings and downloads nothing; afterwards `/system/package/update` has `latest-version`.
   */
  async checkForUpdates(): Promise<RosRecord | undefined> {
    await this.call("POST", "/system/package/update/check-for-updates", {});
    return (await this.get("/system/package/update"))[0];
  }

  /** The router's DNS cache: names it resolved recently, to put names on addresses. */
  dnsCache(): Promise<RosRecord[]> {
    return this.get("/ip/dns/cache");
  }

  async snapshot(plan: ReadPlan = {}): Promise<DeviceSnapshot> {
    const prev = plan.reuse;
    const config = plan.config || !prev;
    const slow = plan.slow || config;
    // Fail loudly on a bad login instead of returning an empty network.
    const resource = await this.get("/system/resource");
    const menus: Record<string, RosRecord[]> = config ? {} : { ...prev!.config.menus };
    const state: Record<string, RosRecord[]> = {};
    if (!slow) for (const p of [...SLOW_PATHS, ...FIXED_PATHS, "/interface/ethernet/poe/monitor", "/interface/wifi/monitor"]) if (prev?.state?.[p]) state[p] = prev.state[p]!;
    if (!config) for (const p of FIXED_PATHS) if (prev?.state?.[p]) state[p] = prev.state[p]!;
    const failed = (key: string) => (err: unknown) => {
      this.errors[key] ??= err instanceof Error ? err.message : String(err);
      return [] as RosRecord[];
    };
    const paths = [...STATE_PATHS, ...(slow ? SLOW_PATHS : []), ...(config ? FIXED_PATHS : [])];
    await Promise.all([
      ...(config ? CONFIG_PATHS : []).map(async (p) => (menus[p] = await this.get(p).catch(failed(`GET ${p}`)))),
      ...paths.map(async (p) => (state[p] = await this.get(p).catch(failed(`GET ${p}`)))),
    ]);
    if (config) {
      // Containers can carry secrets in their command line or environment: keep only what identifies them.
      const keep = ["name", "tag", "remote-image", "interface", "hostname", "status", "running", "stopped"];
      menus["/container"] = (menus["/container"] ?? []).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k))) as RosRecord);
      // REST lists dynamic leases too; the config view should only hold static ones.
      menus["/ip/dhcp-server/lease"] = (menus["/ip/dhcp-server/lease"] ?? []).filter((l) => l.dynamic !== "true");
    }
    const ether = menus["/interface/ethernet"] ?? [];
    const wifi = (menus["/interface/wifi"] ?? []).filter((w) => !w["master-interface"]);
    // PoE ports have their own menu and ids; routers without PoE have none.
    const poePorts = menus["/interface/ethernet/poe"] ?? [];
    const kept = (p: string) => Promise.resolve(prev?.state?.[p] ?? []);
    const [mon, poe, wmon, traffic] = await Promise.all([
      this.monitor("/interface/ethernet", ether).catch(failed("POST /interface/ethernet/monitor")),
      slow ? this.monitor("/interface/ethernet/poe", poePorts).catch(failed("POST /interface/ethernet/poe/monitor")) : kept("/interface/ethernet/poe/monitor"),
      slow ? this.monitor("/interface/wifi", wifi).catch(failed("POST /interface/wifi/monitor")) : kept("/interface/wifi/monitor"),
      this.monitorTraffic(ether.map((e) => e.name ?? "").filter(Boolean)).catch(failed("POST /interface/monitor-traffic")),
    ]);
    state["/interface/ethernet/monitor"] = mon;
    state["/interface/ethernet/poe/monitor"] = poe;
    state["/interface/wifi/monitor"] = wmon;
    state["/interface/monitor-traffic"] = traffic;
    state["/system/resource"] = resource;
    const res = state["/system/resource"]?.[0];
    const at = new Date().toISOString();
    // Errors of menus not read this time still stand.
    const notRead = (key: string) => {
      const p = key.replace(/^(GET|POST) /, "");
      return (!config && (CONFIG_PATHS.includes(p) || FIXED_PATHS.includes(p))) || (!slow && (SLOW_PATHS.includes(p) || p === "/interface/ethernet/poe/monitor" || p === "/interface/wifi/monitor"));
    };
    const errors = { ...Object.fromEntries(Object.entries(prev?.readErrors ?? {}).filter(([k]) => notRead(k))), ...this.errors };
    return {
      role: "router",
      config: { meta: { version: res?.version?.split(" ")[0], model: res?.["board-name"] }, menus },
      state,
      sources: [{ kind: "rest", label: this.opt.url, at }],
      ...(Object.keys(errors).length ? { readErrors: errors } : {}),
    };
  }
}
