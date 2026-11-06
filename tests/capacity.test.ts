// Where the network runs out: traffic now against what each link can carry, and over time.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fullLinks, loadOf, rateBps, wifiCapacity } from "../src/core/capacity.ts";
import { analyze } from "../src/core/analyze.ts";
import { layoutTopology } from "../src/core/layout.ts";
import { buildModel } from "../src/core/model.ts";
import { parseExport, type RosRecord } from "../src/core/ros.ts";
import { HistoryStore } from "../src/server/history.ts";

const RSC = `/interface bridge
add name=lan
/interface bridge port
add bridge=lan interface=ether2
add bridge=lan interface=ether3
/ip address
add address=10.0.0.1/24 interface=lan
/ip pool
add name=p ranges=10.0.0.100-10.0.0.199
/ip dhcp-server
add address-pool=p interface=lan name=d
`;
const NAS = "00:00:5E:00:53:21";
const LAPTOP = "00:00:5E:00:53:22";

function network(nasTx: number, laptopTx: number) {
  const state: Record<string, RosRecord[]> = {
    "/ip/dhcp-server/lease": [
      { address: "10.0.0.21", "mac-address": NAS, server: "d", status: "bound", "host-name": "nas" },
      { address: "10.0.0.22", "mac-address": LAPTOP, server: "d", status: "bound", "host-name": "laptop" },
    ],
    "/interface/bridge/host": [{ "mac-address": NAS, "on-interface": "ether2", bridge: "lan" }],
    "/interface/ethernet/monitor": [{ name: "ether2", status: "link-ok", rate: "1Gbps" }],
    "/interface/monitor-traffic": [{ name: "ether2", "tx-bits-per-second": String(nasTx), "rx-bits-per-second": "1000" }],
    "/interface/wifi/registration-table": [{ "mac-address": LAPTOP, interface: "wifi1", band: "5ghz-ax", signal: "-55", "tx-rate": "866.7Mbps", "rx-rate": "433.3Mbps", "tx-bits-per-second": String(laptopTx), "rx-bits-per-second": "0" }],
  };
  const snap = { collectedAt: "x", devices: [{ role: "router" as const, config: parseExport(RSC), state, sources: [] }] };
  return { m: buildModel(snap), snap };
}

describe("what a link can carry", () => {
  it("reads link rates and puts Wi-Fi at about 60% of its rate", () => {
    expect(rateBps("866.7Mbps")).toBeCloseTo(866.7e6);
    expect(rateBps("1.2Gbps-160MHz/2S")).toBe(1.2e9);
    expect(rateBps(undefined)).toBeUndefined();
    expect(wifiCapacity({ via: { kind: "wifi", txRate: "866.7Mbps" } as never })).toMatchObject({ down: 866.7e6 * 0.6, estimate: true });
    expect(loadOf(900e6, 1e6, { down: 1e9, up: 1e9, label: "" })).toBeCloseTo(0.9);
    expect(loadOf(undefined, undefined, { down: 1e9, label: "" })).toBeUndefined();
  });

  it("finds a cable and a Wi-Fi link at their limit, and draws them with their capacity", () => {
    const { m } = network(950e6, 480e6);
    expect(fullLinks(m).map((l) => [l.id, Math.round(l.share * 100)])).toEqual([
      ["port:ether2", 95],
      [`wifi:${LAPTOP}`, 92],
    ]);
    const link = layoutTopology(m).links.find((l) => l.to === `mac:${NAS}`)!;
    expect(loadOf(link.down, link.up, link.capacity)).toBeCloseTo(0.95);
    expect(fullLinks(network(100e6, 10e6).m)).toEqual([]);
  });
});

describe("over time", () => {
  it("counts the minutes each link was full and puts the busy ones in the review as ideas", () => {
    const h = new HistoryStore(join(mkdtempSync(join(tmpdir(), "stribog-full-")), "history"));
    const t = Date.UTC(2026, 10, 3, 20);
    const { m, snap } = network(950e6, 0);
    for (let i = 0; i < 5; i++) h.appendFull(t + i * 60_000, fullLinks(m));
    h.appendFull(t + 10 * 60_000, []);
    const full = h.fullLinks(t - 1, t + 3600_000);
    expect(full).toMatchObject([{ id: "port:ether2", minutes: 5, deviceIds: [`mac:${NAS}`] }]);
    const f = analyze(m, snap, { full, days: 7 }).findings.find((x) => x.id === "full-port:ether2")!;
    expect(f).toMatchObject({ severity: "suggestion", category: "capacity", devices: [`mac:${NAS}`] });
    expect(f.title).toBe("ether2 (nas) was at its limit for 5 minutes in the last 7 days");
  });
});
