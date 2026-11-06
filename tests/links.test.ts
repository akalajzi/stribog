// One machine with several connections (cable and Wi-Fi): grouped by the DHCP name it gives the
// router, or by notes, and split by notes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectionsOf, connectionViews, buildModel, linkCounters } from "../src/core/model.ts";
import { parseExport, type Notes, type RosRecord } from "../src/core/ros.ts";
import { HistoryStore } from "../src/server/history.ts";
import { NotesError, NotesStore } from "../src/server/notes.ts";
import { samplesOf } from "../src/server/recorder.ts";

const RSC = `/interface bridge
add name=lan
/interface list
add name=LAN
/interface list member
add interface=lan list=LAN
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

const WIRED = "00:00:5E:00:53:21";
const RADIO = "00:00:5E:00:53:22";
const PHONE_A = "00:00:5E:00:53:31";
const PHONE_B = "00:00:5E:00:53:32";
const DESK = "00:00:5E:00:53:41";

const BEHIND = "00:00:5E:00:53:42";

function network(notes: Notes = {}, shareDeskPort = false) {
  const lease = (address: string, mac: string, host: string, comment?: string): RosRecord => ({ address, "mac-address": mac, server: "d", status: "bound", "host-name": host, ...(comment ? { comment } : {}) });
  const reg = (mac: string, signal: string): RosRecord => ({ "mac-address": mac, interface: "wifi1", band: "5ghz-ax", signal, ssid: "home" });
  const state: Record<string, RosRecord[]> = {
    "/ip/dhcp-server/lease": [
      lease("10.0.0.21", WIRED, "kepler"),
      lease("10.0.0.22", RADIO, "Kepler", "Kepler radio (near the wap)"),
      lease("10.0.0.31", PHONE_A, "Pixel-9"),
      lease("10.0.0.32", PHONE_B, "Pixel-9"),
      lease("10.0.0.41", DESK, "desk"),
      ...(shareDeskPort ? [lease("10.0.0.42", BEHIND, "lamp")] : []),
    ],
    "/interface/wifi/registration-table": [reg(RADIO, "-61"), reg(PHONE_A, "-55"), reg(PHONE_B, "-70")],
    "/interface/bridge/host": [
      { "mac-address": WIRED, "on-interface": "ether2", bridge: "lan" },
      { "mac-address": DESK, "on-interface": "ether3", bridge: "lan" },
      ...(shareDeskPort ? [{ "mac-address": BEHIND, "on-interface": "ether3", bridge: "lan" }] : []),
    ],
    "/interface/monitor-traffic": [
      { name: "ether2", "rx-bits-per-second": "2000", "tx-bits-per-second": "9000" },
      { name: "ether3", "rx-bits-per-second": "1000", "tx-bits-per-second": "5000" },
    ],
  };
  const m = buildModel({ collectedAt: "x", notes, devices: [{ role: "router", config: parseExport(RSC), state, sources: [] }] });
  return { m, byMac: (mac: string) => m.devices.find((d) => connectionsOf(d).some((l) => l.mac === mac)) };
}

describe("one machine, several connections", () => {
  it("shows a cable and a Wi-Fi connection with the same DHCP name as one machine, cable first", () => {
    const { m, byMac } = network();
    const d = byMac(WIRED)!;
    expect(byMac(RADIO)).toBe(d);
    expect(d).toMatchObject({ id: `mac:${WIRED}`, name: "kepler", nameSource: "hostname", linkedBy: "hostname", status: "online", ip: "10.0.0.21" });
    expect(d.links!.map((l) => [l.mac, l.via?.kind])).toEqual([
      [WIRED, "port"],
      [RADIO, "wifi"],
    ]);
    expect(d.facts[0]).toBe("Probably one machine with 2 connections (cable (ether2) and Wi-Fi): each gives the router the DHCP name “kepler”");
    expect(m.devices.filter((x) => x.mac === RADIO)).toEqual([]);
    // It is still a Wi-Fi client where radios and signal are concerned.
    expect(connectionViews(m.devices).find((x) => x.mac === RADIO)).toMatchObject({ id: d.id, via: { kind: "wifi", signal: -61 } });
    expect(m.ports.find((p) => p.name === "ether2")!.deviceIds).toEqual([d.id]);
  });

  it("does not guess a kind from what a reservation note says about where a device is", () => {
    // "(near the wap)" describes the place, not the device.
    expect(network().byMac(WIRED)!.kind).toBe("unknown");
  });

  it("keeps two Wi-Fi devices with the same name apart: same-model phones share names", () => {
    const { byMac } = network();
    expect(byMac(PHONE_A)).not.toBe(byMac(PHONE_B));
    expect(byMac(PHONE_A)!.links).toBeUndefined();
  });

  it("keeps a connection whose notes say it is separate on its own", () => {
    const { byMac } = network({ devices: { [RADIO]: { separate: true } } });
    expect(byMac(WIRED)!.links).toBeUndefined();
    expect(byMac(RADIO)!.id).toBe(`mac:${RADIO}`);
  });

  it("joins connections that notes say are one machine, with the name people gave either of them", () => {
    const { byMac } = network({ devices: { [DESK]: { sameAs: PHONE_B, name: "Desk" } } });
    const d = byMac(DESK)!;
    expect(byMac(PHONE_B)).toBe(d);
    expect(d).toMatchObject({ name: "Desk", nameSource: "user", linkedBy: "user" });
    expect(d.facts[0]).toBe("One machine with 2 connections, as its notes say: cable (ether3) and Wi-Fi");
  });
});

describe("notes for connections", () => {
  it("accepts a MAC for sameAs, normalised, and rejects anything else", () => {
    const store = new NotesStore(join(mkdtempSync(join(tmpdir(), "stribog-links-")), "notes.json"), undefined);
    expect(store.updateDevice(DESK, { sameAs: "00-00-5e-00-53-32", separate: false })).toMatchObject({ sameAs: PHONE_B });
    expect(store.get().devices?.[DESK]?.separate).toBeUndefined();
    expect(() => store.updateDevice(DESK, { sameAs: "the laptop" })).toThrow(NotesError);
  });
});

describe("history across connections", () => {
  it("adds up traffic and is online when any connection is", () => {
    const h = new HistoryStore(join(mkdtempSync(join(tmpdir(), "stribog-hist-")), "history"));
    const t = Date.UTC(2026, 10, 2, 12);
    h.appendSamples(t, { [WIRED]: [1, 1000, 200, null], [RADIO]: [0, 50, null, -61] });
    h.appendSamples(t + 60_000, { [RADIO]: [1, 10, 5, -60] });
    expect(h.samples([WIRED, RADIO], t - 1, t + 120_000)).toEqual([
      [t, 1, 1050, 200, -61],
      [t + 60_000, 1, 10, 5, -60],
    ]);
  });
});

describe("traffic where the router has no counter of the link", () => {
  it("uses a router port's counters only for a device that has the port to itself", () => {
    const one = network();
    expect(linkCounters(one.m, one.byMac(DESK)!)).toEqual({ downBps: 5000, upBps: 1000 });
    const shared = network({}, true);
    expect(linkCounters(shared.m, shared.byMac(DESK)!)).toBeUndefined();
    expect(linkCounters(shared.m, shared.byMac(BEHIND)!)).toBeUndefined();
  });

  it("records what the connection table moved for those, and the counters for the rest", () => {
    const { m } = network({}, true);
    const measured = new Map([[DESK, { downBps: 800, upBps: 80 }]]);
    const s = samplesOf({ model: m } as Parameters<typeof samplesOf>[0], measured);
    expect(s[DESK]).toEqual([1, 800, 80, null]);
    expect(s[BEHIND]).toEqual([1, null, null, null]);
    expect(s[WIRED]).toEqual([1, 9000, 2000, null]);
  });
});
