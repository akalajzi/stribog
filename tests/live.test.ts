// Traffic between full reads: a few numbers read on their own and laid over the last picture.

import { describe, expect, it } from "vitest";
import { applyRates, liveRatesFrom } from "../src/core/live.ts";
import { buildModel } from "../src/core/model.ts";
import { parseExport, type RosRecord } from "../src/core/ros.ts";

const RSC = `/interface bridge
add name=lan
/interface bridge port
add bridge=lan interface=ether2
/ip address
add address=10.0.0.1/24 interface=lan
/ip pool
add name=p ranges=10.0.0.100-10.0.0.199
/ip dhcp-server
add address-pool=p interface=lan name=d
`;
const PHONE = "00:00:5E:00:53:22";

describe("live rates", () => {
  const state: Record<string, RosRecord[]> = {
    "/ip/dhcp-server/lease": [{ address: "10.0.0.22", "mac-address": PHONE, server: "d", status: "bound", "host-name": "phone" }],
    "/interface/monitor-traffic": [{ name: "ether2", "rx-bits-per-second": "1000", "tx-bits-per-second": "2000" }],
    "/interface/wifi/registration-table": [{ "mac-address": PHONE, interface: "wifi1", band: "5ghz-ax", signal: "-60", "tx-rate": "433300000", "tx-bits-per-second": "100", "rx-bits-per-second": "50" }],
    "/system/resource": [{ "cpu-load": "3", uptime: "1d", "free-memory": "500", "total-memory": "1000" }],
  };
  const m = buildModel({ collectedAt: "x", devices: [{ role: "router", config: parseExport(RSC), state, sources: [] }] });

  it("reads ports, Wi-Fi devices and the router's load", () => {
    const r = liveRatesFrom([{ name: "ether2", "rx-bits-per-second": "9.5Mbps", "tx-bits-per-second": "120000000" }], [{ "mac-address": "00-00-5e-00-53-22", "tx-bits-per-second": "300000000", "rx-bits-per-second": "1000", signal: "-48" }], { "cpu-load": "41" }, 5);
    expect(r).toEqual({ at: 5, ports: { ether2: [9.5e6, 120e6] }, wifi: { [PHONE]: [300e6, 1000, -48, null, null] }, cpuLoad: 41 });
  });

  it("moves only the numbers, and keeps what it does not cover", () => {
    const r = liveRatesFrom([{ name: "ether2", "rx-bits-per-second": "5", "tx-bits-per-second": "6" }], [{ "mac-address": PHONE, "tx-bits-per-second": "777", "rx-bits-per-second": "8", signal: "-50" }], { "cpu-load": "9" });
    const n = applyRates(m, r);
    expect(n.ports.find((p) => p.name === "ether2")).toMatchObject({ rxBps: 5, txBps: 6 });
    expect(n.devices.find((d) => d.mac === PHONE)?.via).toMatchObject({ downBps: 777, upBps: 8, signal: -50, txRate: "433.3Mbps" });
    expect(n.system).toMatchObject({ cpuLoad: 9, memoryUsed: 50 });
    // The original is untouched: the next full read replaces both anyway.
    expect(m.devices.find((d) => d.mac === PHONE)?.via?.downBps).toBe(100);
  });
});
