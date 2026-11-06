import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { connFlow, flowsFor, namesByAddress, splitAddr } from "../src/core/activity.ts";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { buildModel } from "../src/core/model.ts";
import { HistoryStore } from "../src/server/history.ts";
import { deltas } from "../src/server/recorder.ts";

const DEMO = resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json");
const { config, base } = readConfig(DEMO);
const snap = snapshotFromFiles(config, base);
const m = buildModel(snap);
const st = snap.devices[0]!.state!;

describe("who a device talks to", () => {
  it("splits addresses with and without ports", () => {
    expect(splitAddr("192.0.2.7:443")).toEqual(["192.0.2.7", 443]);
    expect(splitAddr("192.0.2.7")).toEqual(["192.0.2.7", undefined]);
  });

  it("names addresses from the DNS cache, the name that was asked for first", () => {
    const n = namesByAddress(st["/ip/dns/cache"]!);
    expect(n.get("198.51.100.20")).toEqual(["video.stream.example", "edge-12.cdn.example.net"]);
    expect(n.get("203.0.113.88")).toEqual(["mqtt.printers.example"]);
  });

  it("groups a device's connections by the other end and port, biggest first, with direction and bytes", () => {
    const flows = flowsFor("192.168.50.101", st["/ip/firewall/connection"]!, namesByAddress(st["/ip/dns/cache"]!), m);
    expect(flows[0]).toMatchObject({ direction: "out", protocol: "tcp", remote: "198.51.100.20", port: 443, scope: "internet", service: "web (HTTPS)", down: 512334122, up: 1834221, connections: 1 });
    expect(flows[0]!.names![0]).toBe("video.stream.example");
    expect(flows.map((f) => f.remote)).toEqual(["198.51.100.20", "198.51.100.21", "192.0.2.80"]);
  });

  it("marks fast-tracked connections, whose bytes the router may undercount", () => {
    const flows = flowsFor("192.168.50.30", st["/ip/firewall/connection"]!, new Map(), m);
    expect(flows[0]!.fasttracked).toBe(true);
  });

  it("sees a port forward from the device's side", () => {
    const f = connFlow("192.168.50.10", { protocol: "tcp", "src-address": "198.51.100.9:50000", "dst-address": "203.0.113.47:8443", "reply-src-address": "192.168.50.10:443", "orig-bytes": "100", "repl-bytes": "9000" });
    expect(f).toMatchObject({ direction: "in", remote: "198.51.100.9", port: 443, down: 100, up: 9000 });
  });

  it("reads ports from their own fields when addresses come without them", () => {
    const f = connFlow("192.168.50.101", { protocol: "tcp", "src-address": "192.168.50.101", "src-port": "50122", "dst-address": "198.51.100.20", "dst-port": "443", "orig-bytes": "10", "repl-bytes": "20" });
    expect(f).toMatchObject({ remote: "198.51.100.20", port: 443 });
  });

  it("calls broadcast and multicast local, and says what they are", () => {
    const flows = flowsFor("192.168.50.2", [{ protocol: "udp", "src-address": "192.168.50.2:5246", "dst-address": "255.255.255.255:5246", "orig-bytes": "210", "repl-bytes": "0" }, { protocol: "udp", "src-address": "192.168.50.2:5353", "dst-address": "224.0.0.251:5353", "orig-bytes": "90", "repl-bytes": "0" }], new Map(), m);
    expect(flows.map((f) => [f.scope, f.names?.[0]])).toEqual([["local", "everyone on the network (broadcast)"], ["local", "a group of devices (multicast)"]]);
  });

  it("ignores connections that do not involve the device", () => {
    expect(flowsFor("192.168.50.99", st["/ip/firewall/connection"]!, new Map(), m)).toEqual([]);
  });
});

describe("recording", () => {
  it("records only the bytes that moved since the last look", () => {
    const prev = new Map<string, { orig: number; repl: number }>();
    const row = (o: string, r: string) => ({ ".id": "*1", protocol: "tcp", "src-address": "a:1", "dst-address": "b:2", "orig-bytes": o, "repl-bytes": r });
    expect(deltas([row("100", "1000")], prev)[0]).toMatchObject({ "orig-bytes": "100", "repl-bytes": "1000" });
    expect(deltas([row("150", "1000")], prev)[0]).toMatchObject({ "orig-bytes": "50", "repl-bytes": "0" });
    expect(deltas([row("150", "1000")], prev)).toEqual([]);
    // Reused id with smaller counters is a new connection.
    expect(deltas([row("10", "20")], prev)[0]).toMatchObject({ "orig-bytes": "10", "repl-bytes": "20" });
  });

  it("keeps samples and talks per day, merges talks over a range, and thins long ranges by peaks", () => {
    const h = new HistoryStore(join(mkdtempSync(join(tmpdir(), "stribog-hist-")), "history"));
    const t0 = Date.parse("2026-11-01T22:00:00Z");
    for (let i = 0; i < 240; i++) h.appendSamples(t0 + i * 60_000, { "00:00:5E:00:53:70": [1, i === 100 ? 9e7 : 1000, 500, -50] });
    const flow = { direction: "out" as const, protocol: "tcp", remote: "198.51.100.20", port: 443, scope: "internet" as const, down: 1000, up: 10, connections: 1 };
    h.addTalks(t0, new Map([["00:00:5E:00:53:70", [flow]]]));
    h.addTalks(t0 + 3 * 3600_000, new Map([["00:00:5E:00:53:70", [{ ...flow, down: 500 }]]]));

    const all = h.samples("00:00:5E:00:53:70", t0, t0 + 240 * 60_000, 1000);
    expect(all).toHaveLength(240);
    const thin = h.samples("00:00:5E:00:53:70", t0, t0 + 240 * 60_000, 24);
    expect(thin.length).toBeLessThanOrEqual(24);
    expect(Math.max(...thin.map((s) => s[2] ?? 0))).toBe(9e7);

    const talks = h.talks("00:00:5E:00:53:70", t0, t0 + 4 * 3600_000);
    expect(talks).toHaveLength(1);
    expect(talks[0]).toMatchObject({ remote: "198.51.100.20", down: 1500, up: 20 });
    expect(h.since()).toBe(new Date(t0).toISOString());
  });

  it("ships a day of demo history", () => {
    const h = new HistoryStore(resolve(import.meta.dirname, "../fixtures/demo/history"));
    const to = Date.parse("2026-11-02T06:00:00Z");
    expect(h.samples("00:00:5E:00:53:70", to - 30 * 3600_000, to).length).toBeGreaterThan(100);
    expect(h.talks("00:00:5E:00:53:10", to - 30 * 3600_000, to)[0]!.names).toEqual(["backup.example.net"]);
  });
});

describe("the whole network by owner, now", () => {
  it("adds up what every device moved to each network owner, as rates, with who made it", async () => {
    const { networkByOwner } = await import("../src/core/activity.ts");
    const { readConfig, snapshotFromFiles } = await import("../src/core/load.ts");
    const { buildModel } = await import("../src/core/model.ts");
    const { config, base } = readConfig(DEMO);
    const snap = snapshotFromFiles(config, base);
    const m = buildModel(snap);
    const conns = snap.devices[0]!.state!["/ip/firewall/connection"]!;
    const owner = (ip: string) => (ip.startsWith("198.51.100.") ? { asn: 64500, name: "Example Streaming Co." } : undefined);
    const rows = networkByOwner(conns, 60, m, owner);
    const top = rows[0]!;
    expect(top.name).toBe("Example Streaming Co.");
    expect(top.devices.map((d) => d.name)).toContain("Alex MacBook");
    // The NAS's backup goes up to the same owner: both directions count.
    expect(top.upBps).toBeGreaterThan(0);
    expect(top.downBps).toBeGreaterThan(0);
    expect(rows.find((r) => r.name === "Unknown network")).toBeDefined();
    // Rates: bytes over the period, in bits per second.
    const all = conns.reduce((t, c) => t + Number(c["orig-bytes"]) + Number(c["repl-bytes"]), 0);
    expect(rows.reduce((t, r) => t + r.downBps + r.upBps, 0)).toBeLessThanOrEqual(Math.ceil((all * 8) / 60) + rows.length);
  });
});
