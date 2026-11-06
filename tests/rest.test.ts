import { describe, expect, it } from "vitest";
import { CONFIG_PATHS, RouterOsRest, STATE_PATHS } from "../src/core/rest.ts";

interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fake RouterOS REST API: `routes` maps "GET /path" or "POST /path" to a JSON body or a status. */
function fakeRouter(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+\/rest/, "");
    const method = init?.method ?? "GET";
    calls.push({ method, url, path, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return new Response("no such command", { status: 404 });
    if (typeof hit === "number") return new Response("err", { status: hit });
    return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ROUTES: Record<string, unknown> = {
  "GET /system/resource": { version: "7.20.4 (stable)", "board-name": "RB5009UPr+S+", "cpu-load": 3, uptime: "1d" },
  "GET /system/identity": { name: "maple-gw" },
  "GET /interface/ethernet": [
    { ".id": "*1", name: "ether1", "default-name": "ether1", comment: "WAN" },
    { ".id": "*2", name: "ether2", "default-name": "ether2" },
    { ".id": "*9", name: "sfp-sfpplus1", "default-name": "sfp-sfpplus1" },
  ],
  "GET /interface/ethernet/poe": [
    { ".id": "*1", name: "ether1", "poe-out": "auto-on" },
    { ".id": "*2", name: "ether2", "poe-out": "auto-on" },
  ],
  "GET /interface/wifi": [
    { ".id": "*A", name: "cap-wifi1", configuration: "home-2g" },
    { ".id": "*B", name: "cap-guest1", configuration: "guest-2g", "master-interface": "cap-wifi1" },
  ],
  "GET /interface/wifi/security": [{ ".id": "*1", name: "sec-home", passphrase: "correct horse battery staple", "authentication-types": "wpa2-psk,wpa3-psk" }],
  "GET /ip/dhcp-server/lease": [
    { ".id": "*1", address: "192.168.50.10", "mac-address": "00:00:5E:00:53:10", dynamic: "false", status: "bound" },
    { ".id": "*2", address: "192.168.50.101", "mac-address": "00:00:5E:00:53:70", dynamic: "true", status: "bound", "host-name": "laptop" },
  ],
  "GET /ip/dhcp-client": [{ interface: "ether1", address: "203.0.113.47/24", gateway: "203.0.113.1", status: "bound" }],
  "GET /ip/firewall/filter": 500,
  "POST /interface/ethernet/monitor": [
    { status: "link-ok", rate: "1Gbps" },
    { status: "link-ok", rate: "1Gbps" },
    { status: "no-link" },
  ],
  "POST /interface/ethernet/poe/monitor": [{ "poe-out-status": "disabled" }, { "poe-out-status": "powered-on", "poe-out-power": "6.8" }],
  "POST /interface/wifi/monitor": [{ channel: "2412/ax" }],
  "GET /ppp/secret": [{ name: "x", password: "nope" }],
};

describe("RouterOsRest", () => {
  it("reads every config and state menu under /rest with basic auth", async () => {
    const { calls, fetchImpl } = fakeRouter(ROUTES);
    await new RouterOsRest({ url: "https://192.168.50.1/", user: "stribog", password: "s3cret pass", fetchImpl }).snapshot();
    for (const c of calls) {
      expect(c.url.startsWith("https://192.168.50.1/rest/")).toBe(true);
      expect(c.headers.authorization).toBe("Basic " + Buffer.from("stribog:s3cret pass").toString("base64"));
    }
    const gets = new Set(calls.filter((c) => c.method === "GET").map((c) => c.path));
    for (const p of [...CONFIG_PATHS, ...STATE_PATHS]) expect(gets.has(p), p).toBe(true);
    // Nothing but GET and the read-only monitor commands.
    for (const c of calls.filter((x) => x.method !== "GET")) {
      expect(c.method).toBe("POST");
      expect(c.path).toMatch(/\/monitor$/);
    }
  });

  it("monitors ethernet, PoE and Wi-Fi radios once, by id", async () => {
    const { calls, fetchImpl } = fakeRouter(ROUTES);
    const snap = await new RouterOsRest({ url: "http://r", user: "u", password: "p", fetchImpl }).snapshot();
    const post = (p: string) => calls.find((c) => c.method === "POST" && c.path === p)?.body;
    expect(post("/interface/ethernet/monitor")).toEqual({ ".id": "*1,*2,*9", once: "true" });
    expect(post("/interface/ethernet/poe/monitor")).toEqual({ ".id": "*1,*2", once: "true" });
    expect(post("/interface/wifi/monitor")).toEqual({ ".id": "*A", once: "true" });
    expect(Object.keys(snap.readErrors ?? {}).filter((k) => k.startsWith("POST"))).toEqual([]);
    expect(snap.state!["/interface/ethernet/monitor"]).toEqual([
      { name: "ether1", status: "link-ok", rate: "1Gbps" },
      { name: "ether2", status: "link-ok", rate: "1Gbps" },
      { name: "sfp-sfpplus1", status: "no-link" },
    ]);
    expect(snap.state!["/interface/ethernet/poe/monitor"]![1]).toEqual({ name: "ether2", "poe-out-status": "powered-on", "poe-out-power": "6.8" });
    expect(snap.state!["/interface/wifi/monitor"]).toEqual([{ name: "cap-wifi1", channel: "2412/ax" }]);
  });

  it("builds a router DeviceSnapshot with stringified values and hidden secrets", async () => {
    const { fetchImpl } = fakeRouter(ROUTES);
    const snap = await new RouterOsRest({ url: "http://r", user: "u", password: "p", fetchImpl }).snapshot();
    expect(snap.role).toBe("router");
    expect(snap.config.meta).toEqual({ version: "7.20.4", model: "RB5009UPr+S+" });
    expect(snap.sources[0]).toMatchObject({ kind: "rest", label: "http://r" });
    expect(snap.state!["/system/resource"]![0]!["cpu-load"]).toBe("3");
    expect(snap.config.menus["/system/identity"]).toEqual([{ name: "maple-gw" }]);
    expect(snap.config.menus["/interface/wifi/security"]![0]!.passphrase).toBe("<hidden>");
    expect(JSON.stringify(snap)).not.toContain("correct horse");
  });

  it("keeps dynamic leases out of the config but in the state", async () => {
    const { fetchImpl } = fakeRouter(ROUTES);
    const snap = await new RouterOsRest({ url: "http://r", user: "u", password: "p", fetchImpl }).snapshot();
    expect(snap.config.menus["/ip/dhcp-server/lease"]!.map((l) => l.address)).toEqual(["192.168.50.10"]);
    expect(snap.state!["/ip/dhcp-server/lease"]!.map((l) => l.address)).toEqual(["192.168.50.10", "192.168.50.101"]);
    expect(snap.state!["/ip/dhcp-client"]![0]!.address).toBe("203.0.113.47/24");
  });

  it("tolerates 404 menus and failing menus", async () => {
    const { fetchImpl } = fakeRouter(ROUTES);
    const snap = await new RouterOsRest({ url: "http://r", user: "u", password: "p", fetchImpl }).snapshot();
    expect(snap.config.menus["/interface/pppoe-client"]).toEqual([]);
    expect(snap.config.menus["/ip/firewall/filter"]).toEqual([]);
    expect(snap.state!["/interface/wifi/capsman/remote-cap"]).toEqual([]);
    // Failures are kept with the reason; menus this model simply lacks (404 on GET) are not.
    expect(snap.readErrors!["GET /ip/firewall/filter"]).toMatch(/HTTP 500/);
    expect(snap.readErrors!["GET /interface/pppoe-client"]).toBeUndefined();
  });

  it("falls back to `numbers` when a router refuses `.id`, and remembers it", async () => {
    const { calls, fetchImpl } = fakeRouter(ROUTES);
    const picky = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
      if (init?.method === "POST" && body[".id"]) {
        calls.push({ method: "POST", url: String(input), path: "(by id)", headers: {}, body });
        return new Response(JSON.stringify({ error: 400, message: "Bad Request", detail: "unknown parameter .id" }), { status: 400 });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const snap = await new RouterOsRest({ url: "http://picky", user: "u", password: "p", fetchImpl: picky }).snapshot();
    const byName = calls.find((c) => c.method === "POST" && c.path === "/interface/ethernet/monitor")?.body;
    expect(byName).toEqual({ numbers: "*1,*2,*9", once: "true" });
    // The next read uses that shape straight away.
    calls.length = 0;
    await new RouterOsRest({ url: "http://picky", user: "u", password: "p", fetchImpl: picky }).snapshot();
    expect(calls.filter((c) => c.path === "(by id)")).toHaveLength(0);
    expect(snap.state!["/interface/ethernet/monitor"]![0]).toMatchObject({ name: "ether1", rate: "1Gbps" });
    expect(snap.readErrors?.["POST /interface/ethernet/monitor"]).toBeUndefined();
  });

  it("records why a monitor command was refused", async () => {
    const routes = fakeRouter(Object.fromEntries(Object.entries(ROUTES).filter(([k]) => k !== "POST /interface/ethernet/monitor")));
    const snap = await new RouterOsRest({ url: "http://r", user: "u", password: "p", fetchImpl: routes.fetchImpl }).snapshot();
    expect(snap.state!["/interface/ethernet/monitor"]).toEqual([]);
    expect(snap.readErrors!["POST /interface/ethernet/monitor"]).toMatch(/HTTP 404/);
  });

  it("get() returns [] for 404 and 400, and throws on auth errors", async () => {
    const { fetchImpl } = fakeRouter({ "GET /a": 400, "GET /b": 401 });
    const rest = new RouterOsRest({ url: "http://r", user: "u", password: "p", fetchImpl });
    await expect(rest.get("/missing")).resolves.toEqual([]);
    await expect(rest.get("/a")).resolves.toEqual([]);
    await expect(rest.get("/b")).rejects.toThrow("GET /b: HTTP 401");
  });

  it("skips monitor calls when there is nothing to monitor", async () => {
    const { calls, fetchImpl } = fakeRouter({});
    const snap = await new RouterOsRest({ url: "http://r", user: "u", password: "p", fetchImpl }).snapshot();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(snap.state!["/interface/ethernet/monitor"]).toEqual([]);
  });

  it("never reads menus that hold secrets it does not need", async () => {
    const { calls, fetchImpl } = fakeRouter(ROUTES);
    await new RouterOsRest({ url: "http://r", user: "u", password: "p", fetchImpl }).snapshot();
    expect(calls.some((c) => /\/ppp\/secret|\/user|\/certificate/.test(c.path))).toBe(false);
  });
});
