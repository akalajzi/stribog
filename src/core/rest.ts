// RouterOS v7 REST collector.
//
// Reads with GET for every menu and the `monitor ... once` commands (POST, but they only read).
// The web app signs in with the router's own user (usually admin); the CLI can use any user,
// including a read-only one. The REST API is served by `www-ssl`, and by `www` since 7.9.

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
  "/ipv6/nd",
];

export const STATE_PATHS = [
  "/system/resource",
  "/system/routerboard",
  "/interface",
  "/ip/arp",
  "/ip/neighbor",
  "/interface/bridge/host",
  "/interface/wifi/registration-table",
  "/interface/wifi/capsman/remote-cap",
  "/interface/wifi/radio",
];

export interface RestOptions {
  url: string;
  user: string;
  password: string;
  /** Allow self-signed certificates (https only). */
  insecure?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AuthError extends Error {}
export class NotRouterOsError extends Error {}

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
      const req = (https ? httpsRequest : httpRequest)(
        url,
        {
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string>,
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
      if (init?.body) req.write(String(init.body));
      req.end();
    })) as typeof fetch;
}

export class RouterOsRest {
  constructor(private opt: RestOptions) {}

  get url() {
    return this.opt.url;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<RosRecord[]> {
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
      if (res.status === 401 || res.status === 403) throw new AuthError(`${method} ${path}: HTTP ${res.status} (check the user and its policies)`);
      if (res.status === 404 || res.status === 400) return []; // menu absent on this model / package
      if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
      const data = (await res.json().catch(() => {
        throw new NotRouterOsError(`${method} ${path}: the answer is not RouterOS JSON`);
      })) as unknown;
      const rows = Array.isArray(data) ? data : [data];
      return rows.map((r) => scrub(Object.fromEntries(Object.entries(r as object).map(([k, v]) => [k, String(v)])) as RosRecord));
    } finally {
      clearTimeout(t);
    }
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

  /** `monitor numbers=... once` for every item in a menu. */
  async monitor(menuPath: string, names: string[]) {
    if (!names.length) return [];
    const rows = await this.call("POST", `${menuPath}/monitor`, { numbers: names.join(","), once: "" });
    return rows.map((r, i) => ({ name: names[i] ?? r.name ?? "", ...r }));
  }

  async snapshot(): Promise<DeviceSnapshot> {
    // Fail loudly on a bad login instead of returning an empty network.
    const resource = await this.get("/system/resource");
    const menus: Record<string, RosRecord[]> = {};
    const state: Record<string, RosRecord[]> = {};
    await Promise.all([
      ...CONFIG_PATHS.map(async (p) => (menus[p] = await this.get(p).catch(() => []))),
      ...STATE_PATHS.filter((p) => p !== "/system/resource").map(async (p) => (state[p] = await this.get(p).catch(() => []))),
      this.get("/ip/dhcp-client").then((r) => (state["/ip/dhcp-client"] = r)).catch(() => {}),
      this.get("/ip/dhcp-server/lease").then((r) => (state["/ip/dhcp-server/lease"] = r)).catch(() => {}),
    ]);
    // REST lists dynamic leases too; the config view should only hold static ones.
    menus["/ip/dhcp-server/lease"] = (menus["/ip/dhcp-server/lease"] ?? []).filter((l) => l.dynamic !== "true");
    const ether = (menus["/interface/ethernet"] ?? []).map((e) => e.name ?? "").filter(Boolean);
    const wifi = (menus["/interface/wifi"] ?? []).filter((w) => !w["master-interface"]).map((w) => w.name ?? "").filter(Boolean);
    const [mon, poe, wmon] = await Promise.all([
      this.monitor("/interface/ethernet", ether).catch(() => []),
      this.monitor("/interface/ethernet/poe", ether.filter((e) => e.startsWith("ether"))).catch(() => []),
      this.monitor("/interface/wifi", wifi).catch(() => []),
    ]);
    state["/interface/ethernet/monitor"] = mon;
    state["/interface/ethernet/poe/monitor"] = poe;
    state["/interface/wifi/monitor"] = wmon;
    state["/system/resource"] = resource;
    const res = state["/system/resource"]?.[0];
    const at = new Date().toISOString();
    return {
      role: "router",
      config: { meta: { version: res?.version?.split(" ")[0], model: res?.["board-name"] }, menus },
      state,
      sources: [{ kind: "rest", label: this.opt.url, at }],
    };
  }
}
