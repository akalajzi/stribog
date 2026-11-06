import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateUrls, LoginError, signIn } from "../src/server/session.ts";
import { handleApi } from "../src/server/server.ts";

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
    writeFileSync(join(dir, "stribog.config.json"), JSON.stringify({ router: { url: `http://127.0.0.1:${port}` }, debug: { saveSnapshot: "live.json" } }));
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

  it("offers the demo network without a router", async () => {
    const res = await post("/api/demo", {});
    const jar = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
    const net = await (await fetch(base + "/api/network", { headers: jar })).json();
    expect(net.meta.mode).toBe("demo");
    expect(net.model.site).toBe("Maple Street");
  });
});
