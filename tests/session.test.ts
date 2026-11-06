import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateUrls, LoginError, signIn } from "../src/server/session.ts";
import { handleApi } from "../src/server/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const RESOURCE = { version: "7.20.4 (stable)", "board-name": "RB5009UPr+S+", uptime: "1d" };

/** fetch stand-in: `answer(url)` returns a Response or throws like a refused connection. */
function fakeFetch(answer: (url: string, auth: string) => Response) {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    return answer(url, (init?.headers as Record<string, string>).authorization ?? "");
  }) as typeof fetch;
  return { urls, f };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const refused = () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED") });
};

describe("candidateUrls", () => {
  it("tries https before http for a bare address", () => {
    expect(candidateUrls(" 192.168.88.1 ")).toEqual(["https://192.168.88.1", "http://192.168.88.1"]);
    expect(candidateUrls("router.lan:8443/webfig/")).toEqual(["https://router.lan:8443", "http://router.lan:8443"]);
  });
  it("uses an explicit scheme as given, without the path", () => {
    expect(candidateUrls("HTTP://192.168.88.1/webfig/")).toEqual(["http://192.168.88.1"]);
    expect(candidateUrls("https://r")).toEqual(["https://r"]);
  });
  it("has nothing to try for an empty address", () => {
    expect(candidateUrls("  ")).toEqual([]);
  });
});

describe("signIn", () => {
  it("falls back to http when https is off, and says so", async () => {
    const { urls, f } = fakeFetch((url) => {
      if (url.startsWith("https://")) refused();
      if (url.endsWith("/system/identity")) return json([{ name: "maple-gw" }]);
      return json(RESOURCE);
    });
    const r = await signIn("192.168.50.1", "admin", "pw", f);
    expect(r).toMatchObject({ url: "http://192.168.50.1", user: "admin", encrypted: false, identity: "maple-gw", version: "7.20.4", model: "RB5009UPr+S+" });
    expect(urls[0]).toBe("https://192.168.50.1/rest/system/resource");
  });

  it("prefers https when the router answers on it", async () => {
    const { f } = fakeFetch((url) => (url.endsWith("/system/identity") ? json({ name: "maple-gw" }) : json(RESOURCE)));
    expect((await signIn("192.168.50.1", "admin", "pw", f)).encrypted).toBe(true);
  });

  it("stops at a refused password instead of retrying it over plain http", async () => {
    const { urls, f } = fakeFetch(() => new Response("", { status: 401 }));
    const err = await signIn("192.168.50.1", "admin", "wrong", f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect(err).toMatchObject({ status: 401 });
    expect(urls.every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("allows an empty password, as on a router that was never set up", async () => {
    const { f } = fakeFetch((_url, auth) => (auth === "Basic " + Buffer.from("admin:").toString("base64") ? json(RESOURCE) : new Response("", { status: 401 })));
    await expect(signIn("192.168.50.1", "admin", "", f)).resolves.toMatchObject({ user: "admin" });
  });

  it("tells a web server that is not RouterOS apart from no answer at all", async () => {
    const html = fakeFetch(() => new Response("<html>hello</html>", { status: 200 }));
    await expect(signIn("192.0.2.9", "admin", "pw", html.f)).rejects.toThrow(/not as a RouterOS 7 router/);
    const none = fakeFetch(refused);
    await expect(signIn("192.0.2.9", "admin", "pw", none.f)).rejects.toThrow(/Could not reach a router at 192\.0\.2\.9/);
  });
});

describe("web API sessions", () => {
  let router: Server;
  let app: Server;
  let base = "";
  let snapFile = "";
  const seen: string[] = [];
  const AUTH = "Basic " + Buffer.from("admin:s3cret").toString("base64");

  beforeAll(async () => {
    // A tiny RouterOS: checks basic auth, answers a few menus, 404 for the rest.
    router = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== AUTH) return void res.writeHead(401).end();
      const body: Record<string, unknown> = {
        "/rest/system/resource": RESOURCE,
        "/rest/system/identity": { name: "maple-gw" },
        "/rest/interface/ethernet": [{ ".id": "*1", name: "ether1", "default-name": "ether1" }],
      };
      const hit = body[req.url ?? ""];
      if (!hit) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(hit));
    });
    await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
    const port = (router.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "stribog-"));
    snapFile = join(dir, "live.json");
    writeFileSync(join(dir, "stribog.config.json"), JSON.stringify({ router: { url: `http://127.0.0.1:${port}` }, debug: { saveSnapshot: "live.json" }, dataDir: "data" }));
    process.env.STRIBOG_CONFIG = join(dir, "stribog.config.json");

    app = createServer(async (req, res) => {
      if (!(await handleApi(req, res))) res.writeHead(404).end();
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  });

  afterAll(() => {
    delete process.env.STRIBOG_CONFIG;
    router.close();
    app.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("asks to sign in, with the configured router address", async () => {
    const info = await (await fetch(base + "/api/session")).json();
    expect(info).toMatchObject({ signedIn: false, login: { addressFixed: true } });
    expect(info.login.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(base + "/api/network")).status).toBe(401);
  });

  it("refuses a wrong password and sets no session", async () => {
    const res = await post("/api/login", { user: "admin", password: "nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses sign-in from another site", async () => {
    expect((await post("/api/login", { user: "admin", password: "s3cret" }, { origin: "http://evil.example" })).status).toBe(403);
    const form = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "user=admin" });
    expect(form.status).toBe(403);
  });

  it("signs in, reads the router live with the same credentials, and signs out", async () => {
    const res = await post("/api/login", { user: "admin", password: "s3cret", address: "http://192.0.2.1" });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^stribog_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict$/);
    const jar = { cookie: cookie.split(";")[0]! };

    const info = await (await fetch(base + "/api/session", { headers: jar })).json();
    expect(info).toMatchObject({ signedIn: true, kind: "router", user: "admin", router: { encrypted: false, identity: "maple-gw", version: "7.20.4" } });
    expect(JSON.stringify(info)).not.toContain("s3cret");

    const net = await (await fetch(base + "/api/network", { headers: jar })).json();
    expect(net.meta.mode).toBe("live");
    expect(net.model.devices.find((d: { id: string }) => d.id === net.model.routerId)?.name).toBe("maple-gw");
    expect(JSON.stringify(net)).not.toContain("s3cret");
    // The development snapshot holds the read, never the credentials.
    const saved = readFileSync(snapFile, "utf8");
    expect(JSON.parse(saved).devices[0].config.menus["/system/identity"]).toEqual([{ name: "maple-gw" }]);
    expect(saved).not.toContain("s3cret");
    expect(statSync(snapFile).mode & 0o777).toBe(0o600);
    // Signed in at the configured address, not the one the browser sent (192.0.2.1 would not answer).
    expect(seen.some((s) => s.startsWith("GET /rest/"))).toBe(true);

    await post("/api/logout", {}, jar);
    expect((await fetch(base + "/api/network", { headers: jar })).status).toBe(401);
  });

  it("lets a signed-in person keep notes and connect an agent with the same rights", async () => {
    const res = await post("/api/login", { user: "admin", password: "s3cret" });
    const jar = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = jar) =>
      fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

    const saved = await (await call("PATCH", "/api/notes/devices/00:00:5E:00:53:10", { name: "Family NAS", labels: ["storage"] })).json();
    expect(saved).toMatchObject({ name: "Family NAS", labels: ["storage"] });
    expect((await call("PATCH", "/api/notes/devices/00:00:5E:00:53:10", { room: "Hall" })).status).toBe(400);

    // An agent token: shown once, then works without the cookie.
    const created = await (await call("POST", "/api/tokens", { name: "My agent" })).json();
    expect(created.token).toMatch(/^stb_/);
    const auth = { authorization: `Bearer ${created.token}` };
    expect(await (await fetch(base + "/api/notes", { headers: auth })).json()).toMatchObject({ devices: { "00:00:5E:00:53:10": { name: "Family NAS" } } });
    const byAgent = await call("PATCH", "/api/notes/devices/00:00:5E:00:53:10", { services: [{ name: "DNS", port: 53 }] }, { ...auth, origin: "http://elsewhere.example" });
    expect(byAgent.status).toBe(200);
    const net = await (await fetch(base + "/api/network", { headers: auth })).json();
    expect(net.meta.mode).toBe("live");
    // Agents cannot mint or list tokens, and a wrong token is refused outright.
    expect((await call("GET", "/api/tokens", undefined, auth)).status).toBe(403);
    expect((await fetch(base + "/api/notes", { headers: { authorization: "Bearer stb_nope" } })).status).toBe(401);

    const log = await (await fetch(base + "/api/notes/audit", { headers: jar })).json();
    expect(log.map((e: { target: string }) => e.target)).toEqual(["device:00:00:5E:00:53:10", "device:00:00:5E:00:53:10"]);
    expect(log[0].after.services).toEqual([{ name: "DNS", port: 53 }]);

    expect((await call("DELETE", `/api/tokens/${created.info.id}`)).status).toBe(200);
    expect((await fetch(base + "/api/notes", { headers: auth })).status).toBe(401);
  });

  it("serves agents over MCP with a token: read the network, write notes", async () => {
    const res = await post("/api/login", { user: "admin", password: "s3cret" });
    const jar = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
    const { token } = await (await post("/api/tokens", { name: "MCP test" }, jar)).json();

    const unauth = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauth.status).toBe(401);

    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["get_change_log", "get_device", "get_device_activity", "get_network_overview", "get_review", "list_devices", "update_device_notes", "update_network_notes"]);

    const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
    const ov = text(await client.callTool({ name: "get_network_overview", arguments: {} }));
    expect(ov).toMatchObject({ data: { mode: "live" }, router: { name: "maple-gw", version: "7.20.4" } });

    const upd = await client.callTool({ name: "update_device_notes", arguments: { mac: "00:00:5e:00:53:99", name: "Garage Pi", labels: ["garage"], services: [{ name: "Home Assistant", port: 8123 }] } });
    expect(text(upd)).toMatchObject({ mac: "00:00:5E:00:53:99", notes: { name: "Garage Pi", labels: ["garage"] } });
    const bad = await client.callTool({ name: "update_device_notes", arguments: { mac: "nope", name: "x" } });
    expect(bad.isError).toBe(true);

    const dev = text(await client.callTool({ name: "get_device", arguments: { device: "Garage Pi" } }));
    expect(dev).toMatchObject({ name: "Garage Pi", nameFrom: "user", services: [{ name: "Home Assistant", port: 8123 }] });
    const act = text(await client.callTool({ name: "get_device_activity", arguments: { device: "Garage Pi" } }));
    expect(act).toMatchObject({ device: { name: "Garage Pi" }, now: { flows: [] }, recorded: { samples: 0 } });
    const log = text(await client.callTool({ name: "get_change_log", arguments: { limit: 1 } }));
    expect(log[0].target).toBe("device:00:00:5E:00:53:99");
    await client.close();
  });

  it("offers the demo network without a router", async () => {
    const res = await post("/api/demo", {});
    const jar = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
    const net = await (await fetch(base + "/api/network", { headers: jar })).json();
    expect(net.meta.mode).toBe("demo");
    expect(net.model.site).toBe("Maple Street");
    // Details of a device: who it talks to now (the demo's connection table) and its recorded day.
    const act = await (await fetch(base + `/api/devices/${encodeURIComponent("mac:00:00:5E:00:53:70")}/activity?hours=24`, { headers: jar })).json();
    expect(act.device.name).toBe("Alex MacBook");
    expect(act.now.flows[0]).toMatchObject({ remote: "198.51.100.20", port: 443, names: ["video.stream.example", "edge-12.cdn.example.net"] });
    expect(act.history.samples.length).toBeGreaterThan(100);
    expect(act.history.talks[0].names[0]).toBe("video.stream.example");
    expect(act.now.flows[0].owner).toMatchObject({ asn: 64500, name: "Example Streaming Co." });
    expect(act.owners.ready).toBe(true);
    expect(act.owners.now[0]).toMatchObject({ name: "Example Streaming Co.", asn: 64500 });
    expect((await fetch(base + "/api/devices/mac%3A00%3A00%3A5E%3A00%3A53%3AFF/activity", { headers: jar })).status).toBe(404);
  });
});
