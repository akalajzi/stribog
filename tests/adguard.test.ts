// AdGuard Home as a source: its query log, read page by page, as names each device looked up.

import { describe, expect, it } from "vitest";
import { AdGuard, AdGuardError, baseDomain, connectAdGuard, demoDnsLog, deviceLookups, summarise, toLookup, withNames, type AdGuardLogin } from "../src/server/adguard.ts";
import { deviceActivity } from "../src/server/device-activity.ts";

const LOGIN: AdGuardLogin = { url: "http://192.0.2.10", user: "admin", password: "pw", encrypted: false };
const T0 = Date.UTC(2026, 10, 2, 12);
const at = (min: number) => new Date(T0 - min * 60_000).toISOString();
const item = (min: number, client: string, name: string, answer: string[] = [], reason = "NotFilteredNotFound") => ({
  time: at(min),
  client,
  question: { name, type: "A" },
  reason,
  answer: answer.map((value) => ({ type: "A", value })),
});

/** A query log of AdGuard's shape, newest first, served in pages of `size`. */
function fakeServer(items: ReturnType<typeof item>[], size = 2) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    calls.push(u);
    if ((init?.headers as Record<string, string>).authorization !== `Basic ${Buffer.from("admin:pw").toString("base64")}`) return new Response("", { status: 401 });
    if (u.pathname === "/control/status") return Response.json({ version: "v0.107.99", dns_addresses: ["192.0.2.10"] });
    if (u.pathname === "/control/querylog/config") return Response.json({ enabled: true, interval: 86_400_000, anonymize_client_ip: false });
    const older = u.searchParams.get("older_than");
    const search = u.searchParams.get("search")?.replace(/^"|"$/g, "");
    const rows = items.filter((r) => (!older || r.time < older) && (!search || r.client.startsWith(search))).slice(0, size);
    return Response.json({ data: rows, oldest: rows.at(-1)?.time ?? "" });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const LOG = [
  item(1, "192.0.2.21", "video.cdn.example.co.uk", ["198.51.100.20"]),
  item(2, "192.0.2.21", "ads.tracker.example", [], "FilteredBlackList"),
  item(3, "192.0.2.210", "other.example", ["198.51.100.99"]),
  item(4, "192.0.2.21", "img.cdn.example.co.uk", ["198.51.100.21"]),
  item(5, "192.0.2.21", "1.2.0.192.in-addr.arpa"),
  item(90, "192.0.2.21", "old.example"),
];

describe("connecting", () => {
  it("checks the password and remembers the version", async () => {
    const { fetchImpl } = fakeServer(LOG);
    await expect(connectAdGuard("192.0.2.10", "admin", "pw", fetchImpl)).resolves.toMatchObject({ url: "https://192.0.2.10", version: "v0.107.99" });
    await expect(connectAdGuard("http://192.0.2.10", "admin", "nope", fetchImpl)).rejects.toThrow(AdGuardError);
  });

  it("tells a web page that is not AdGuard (a NAS's own, before a reverse proxy) from no answer", async () => {
    const page = (async () => new Response("<!DOCTYPE html><html></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(connectAdGuard("192.0.2.10", "admin", "pw", page)).rejects.toThrow(/not as AdGuard Home.*reverse proxy/);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(connectAdGuard("192.0.2.10", "admin", "pw", down)).rejects.toThrow(/Could not reach/);
  });
});

describe("the query log", () => {
  it("pages back to a time, of one client exactly", async () => {
    const { fetchImpl, calls } = fakeServer(LOG);
    const { items } = await new AdGuard(LOGIN, fetchImpl).lookups(T0 - 60 * 60_000, { client: "192.0.2.21" });
    expect(items.map((l) => l.name)).toEqual(["video.cdn.example.co.uk", "ads.tracker.example", "img.cdn.example.co.uk", "1.2.0.192.in-addr.arpa"]);
    expect(calls[0]!.searchParams.get("search")).toBe('"192.0.2.21"');
    expect(calls.length).toBeGreaterThan(1);
  });

  it("marks what block lists refused", () => {
    expect(toLookup(LOG[1]!)).toMatchObject({ blocked: true, answers: [] });
    expect(toLookup(LOG[0]!)).toMatchObject({ blocked: false, answers: ["198.51.100.20"] });
  });

  it("groups names by registered domain and leaves reverse lookups out", () => {
    expect(baseDomain("video.cdn.example.co.uk")).toBe("example.co.uk");
    expect(baseDomain("a.b.example.com")).toBe("example.com");
    expect(baseDomain("nas")).toBe("nas");
    const s = summarise(LOG.slice(0, 5).map((r) => toLookup(r)!).filter((l) => l.client === "192.0.2.21"));
    expect(s).toMatchObject({ total: 3, blocked: 1 });
    expect(s.domains.map((d) => [d.domain, d.count, d.names.length])).toEqual([
      ["example.co.uk", 2, 2],
      ["tracker.example", 1, 1],
    ]);
  });

  it("names a device's addresses with what it was told, before the router's cache", async () => {
    const { fetchImpl } = fakeServer(LOG, 10);
    const { use, names } = await deviceLookups(new AdGuard(LOGIN, fetchImpl), ["192.0.2.21"], T0 - 60 * 60_000, T0);
    expect(use).toMatchObject({ source: "AdGuard Home", total: 3, keptMs: 86_400_000 });
    expect(names.get("198.51.100.20")).toEqual(["video.cdn.example.co.uk"]);
    expect(names.has("198.51.100.99")).toBe(false);
    const merged = withNames(new Map([["198.51.100.20", ["someone-else.example"]], ["192.0.2.1", ["x.example"]]]), names);
    expect(merged.get("198.51.100.20")).toEqual(["video.cdn.example.co.uk"]);
    expect(merged.get("192.0.2.1")).toEqual(["x.example"]);
  });

  it("says when it cannot be read", async () => {
    const { use } = await deviceLookups(new AdGuard({ ...LOGIN, password: "wrong" }, fakeServer(LOG).fetchImpl), ["192.0.2.21"], 0, T0);
    expect(use.error).toMatch(/did not accept/);
  });
});

describe("the demo", () => {
  it("ships a sample log, and a device's details show what it looked up", async () => {
    const { items } = await demoDnsLog.lookups(0, { client: "192.168.50.30" });
    expect(items.length).toBeGreaterThan(50);
    const a = (await deviceActivity({ session: { id: "t", kind: "demo", seenAt: Date.now() }, agent: false, id: "mac:00:00:5E:00:53:30", hours: 24 }))!;
    expect(a.dns?.domains.map((d) => d.domain)).toContain("tv-maker.example");
    expect(a.dns?.blocked).toBeGreaterThan(0);
  });
});
