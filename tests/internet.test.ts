import { describe, expect, it } from "vitest";
import { episodes, judge, pingResult, rosMs, summarize, thin, together, type NetSample, type Probe } from "../src/core/internet.ts";
import { checkInternet } from "../src/server/recorder.ts";
import { getNetwork } from "../src/server/provider.ts";
import { createSession } from "../src/server/session.ts";
import type { RouterOsRest } from "../src/core/rest.ts";
import type { RosRecord } from "../src/core/ros.ts";

const ok = (rtt = 12): Probe => ({ sent: 3, received: 3, rtt });
const none: Probe = { sent: 3, received: 0 };

describe("rosMs", () => {
  it("reads RouterOS durations", () => {
    expect(rosMs("453us")).toBe(0.45);
    expect(rosMs("12ms345us")).toBe(12.35);
    expect(rosMs("1s2ms")).toBe(1002);
    expect(rosMs("")).toBeUndefined();
    expect(rosMs("timeout")).toBeUndefined();
  });
});

describe("pingResult", () => {
  it("takes the running totals of the last row", () => {
    const rows: RosRecord[] = [
      { host: "1.1.1.1", seq: "0", time: "11ms", sent: "1", received: "1", "packet-loss": "0", "avg-rtt": "11ms" },
      { host: "1.1.1.1", seq: "1", status: "timeout", sent: "2", received: "1", "packet-loss": "50", "avg-rtt": "11ms" },
      { host: "1.1.1.1", seq: "2", time: "13ms", sent: "3", received: "2", "packet-loss": "33", "avg-rtt": "12ms" },
    ];
    expect(pingResult(rows)).toEqual({ sent: 3, received: 2, rtt: 12 });
  });
  it("has no round trip when nothing came back", () => {
    expect(pingResult([{ seq: "0", status: "timeout", sent: "1", received: "0", "avg-rtt": "0ms" }])).toEqual({ sent: 1, received: 0, rtt: undefined });
  });
  it("counts rows when there are no totals", () => {
    expect(pingResult([{ time: "10ms" }, { status: "timeout" }, { time: "14ms" }])).toEqual({ sent: 3, received: 2, rtt: 12 });
  });
  it("is empty for an empty answer (no `test` policy)", () => {
    expect(pingResult([])).toEqual({ sent: 0, received: 0, rtt: undefined });
  });
});

describe("judge", () => {
  it("is up when a public address answers, even if the other does not", () => {
    expect(judge({ targets: [ok(), { sent: 3, received: 3, rtt: 20 }] })).toEqual({ s: "up" });
    expect(together([ok(10), { sent: 3, received: 3, rtt: 20 }]).rtt).toBe(15);
  });
  it("is unsteady from a fifth of the packets lost", () => {
    expect(judge({ targets: [{ sent: 3, received: 2, rtt: 12 }, ok()] })).toEqual({ s: "up" });
    expect(judge({ targets: [{ sent: 3, received: 1, rtt: 12 }, ok()] })).toEqual({ s: "unsteady" });
  });
  it("puts a fault where the answers stop", () => {
    const down = { targets: [none, none] };
    expect(judge({ ...down, linkUp: false, address: null })).toEqual({ s: "down", w: "link" });
    expect(judge({ ...down, linkUp: true, address: null })).toEqual({ s: "down", w: "address" });
    expect(judge({ ...down, linkUp: true, address: "198.51.100.7", gateway: ok(2) })).toEqual({ s: "down", w: "provider" });
    expect(judge({ ...down, gateway: none, gatewayAnswers: true })).toEqual({ s: "down", w: "gateway" });
  });
  it("does not blame the provider's box when it never answers pings", () => {
    expect(judge({ targets: [none, none], gateway: none, gatewayAnswers: false })).toEqual({ s: "down", w: "beyond" });
    expect(judge({ targets: [none, none], gateway: none })).toEqual({ s: "down", w: "beyond" });
    expect(judge({ targets: [none, none] })).toEqual({ s: "down", w: "beyond" });
  });
});

const T0 = Date.UTC(2026, 0, 1);
const min = (k: number, s: NetSample["s"], extra: Partial<NetSample> = {}): NetSample => ({ t: T0 + k * 60_000, s, n: s === "down" ? [6, 0, null] : [6, 6, 12 + k % 3], g: [3, 3, 2], ...extra });

describe("episodes", () => {
  it("joins bad minutes in a row, newest first, with the most common place", () => {
    const s = [min(0, "up"), min(1, "down", { w: "provider" }), min(2, "down", { w: "provider" }), min(3, "down", { w: "beyond" }), min(4, "up"), min(5, "unsteady"), min(6, "up")];
    expect(episodes(s)).toEqual([
      { state: "unsteady", from: T0 + 5 * 60_000, to: T0 + 6 * 60_000, ongoing: false },
      { state: "down", from: T0 + 60_000, to: T0 + 4 * 60_000, where: "provider", ongoing: false },
    ]);
  });
  it("splits a stretch at a gap in the recording and marks one still going", () => {
    const s = [min(0, "down"), min(1, "down"), min(10, "down")];
    const e = episodes(s);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ from: T0 + 10 * 60_000, ongoing: true });
    expect(e[1]).toMatchObject({ from: T0, to: T0 + 2 * 60_000, ongoing: false });
  });
  it("splits when the kind of trouble changes", () => {
    expect(episodes([min(0, "down"), min(1, "unread", { w: "router" }), min(2, "up")]).map((e) => e.state)).toEqual(["unread", "down"]);
  });
});

describe("summarize and thin", () => {
  const s = Array.from({ length: 100 }, (_, k) => min(k, k >= 40 && k < 45 ? "down" : "up"));
  it("counts minutes and round trips that answered", () => {
    const sum = summarize(s, T0, T0 + 99 * 60_000);
    expect(sum.minutes).toEqual({ recorded: 100, down: 5, unsteady: 0, unread: 0 });
    expect(sum.latency!.median).toBeGreaterThanOrEqual(12);
    expect(sum.gatewayLatency).toEqual({ median: 2, p95: 2 });
    expect(sum.now?.s).toBe("up");
    expect(sum.episodes).toHaveLength(1);
  });
  it("has no 'now' when the last minute is old", () => {
    expect(summarize(s, T0, T0 + 200 * 60_000).now).toBeUndefined();
  });
  it("keeps the worst minute of each bucket", () => {
    const t = thin(s, 10);
    expect(t).toHaveLength(10);
    expect(t.filter((x) => x.s === "down")).toHaveLength(1);
  });
});

describe("checkInternet", () => {
  /** A router stand-in that answers pings from a table: address → rows. */
  const router = (answers: Record<string, RosRecord[]>) => ({ ping: async (a: string) => answers[a] ?? [] }) as unknown as RouterOsRest;
  const rows = (n: number, of = 3): RosRecord[] => [{ sent: String(of), received: String(n), "avg-rtt": n ? "12ms" : "0ms" }];

  it("records a minute from the demo's WAN and learns whether the gateway answers", async () => {
    const p = await getNetwork(createSession("demo"));
    const gw = p.model.wan.gateway!;
    const seen = new Map<string, boolean>();
    const up = await checkInternet(router({ [gw]: rows(3), "1.1.1.1": rows(3), "8.8.8.8": rows(3) }), p, seen, 1);
    expect(up).toMatchObject({ t: 1, s: "up", g: [3, 3, 12], n: [6, 6, 12] });
    expect(seen.get(gw)).toBe(true);
    const down = await checkInternet(router({ [gw]: rows(0) }), p, seen, 2);
    // The answers were empty for the public addresses: nothing to judge.
    expect(down).toBeUndefined();
    const out = await checkInternet(router({ [gw]: rows(0), "1.1.1.1": rows(0), "8.8.8.8": rows(0) }), p, seen, 3);
    expect(out).toMatchObject({ s: "down", w: "gateway" });
  });
});
