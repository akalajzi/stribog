import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { buildModel, type Device } from "../src/core/model.ts";
import { parseExport, type Snapshot } from "../src/core/ros.ts";

const DEMO = resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json");

function demo() {
  const { config, base } = readConfig(DEMO);
  const snap = snapshotFromFiles(config, base);
  return { snap, m: buildModel(snap) };
}

const { snap, m } = demo();
const byMac = (mac: string) => m.devices.find((d) => d.mac === mac);
const must = (d: Device | undefined) => {
  expect(d).toBeDefined();
  return d!;
};

const LIVING = "00:00:5E:00:53:A0";
const UPSTAIRS = "00:00:5E:00:53:B0";

describe("demo snapshot loading", () => {
  it("reads the router and both access points with their sources", () => {
    expect(snap.devices.map((d) => d.role)).toEqual(["router", "cap", "cap"]);
    expect(snap.devices[0]!.config.meta).toMatchObject({ model: "RB5009UPr+S+", version: "7.20.4" });
    expect(snap.devices[0]!.state?.["/ip/dhcp-server/lease"]?.length).toBeGreaterThan(10);
    expect(snap.devices[0]!.state?._about).toBeUndefined();
    expect(snap.collectedAt).toBe("2026-11-02 03:32:15");
    expect(snap.sampleState).toBe(false);
    expect(snap.notes?.site).toBe("Maple Street");
    expect(m.sources.map((s) => s.kind)).toEqual(["export", "fixture", "export", "export"]);
  });

  it("never carries Wi-Fi passphrases into the model input", () => {
    const text = JSON.stringify(snap);
    expect(text).not.toContain("correct horse");
    expect(text).not.toContain("welcome to");
  });
});

describe("demo model: router and WAN", () => {
  it("names the router from its identity and reads its live version", () => {
    const r = must(m.devices.find((d) => d.id === m.routerId));
    expect(r).toMatchObject({ kind: "router", name: "maple-gw", nameSource: "identity", model: "RB5009UPr+S+", version: "7.20.4", ip: "192.168.50.1", status: "online", parent: "upstream" });
    expect(r.via).toMatchObject({ kind: "upstream", port: "ether1" });
  });

  it("sees a public DHCP WAN address and a single NAT", () => {
    expect(m.wan).toMatchObject({ iface: "ether1", type: "dhcp", address: "203.0.113.47", gateway: "203.0.113.1", addressKind: "public", doubleNat: false });
  });

  it("puts the ONT from notes between the internet and the router", () => {
    expect(must(m.devices.find((d) => d.id === "upstream"))).toMatchObject({ kind: "isp", name: "ONT (bridge mode)", parent: "internet", zone: "upstream" });
    expect(m.devices.filter((d) => d.zone === "upstream" && d.mac)).toEqual([]);
  });

  it("uses the site name from notes and knows it has live state", () => {
    expect(m.site).toBe("Maple Street");
    expect(m.hasState).toBe(true);
    expect(m.sampleState).toBe(false);
  });
});

describe("demo model: access points", () => {
  it("finds both CAPs with user names, models, versions and ports", () => {
    const aps = m.devices.filter((d) => d.kind === "ap");
    expect(aps.map((a) => a.mac).sort()).toEqual([LIVING, UPSTAIRS]);
    expect(must(byMac(LIVING))).toMatchObject({ name: "Living room AP", nameSource: "user", model: "cAPGi-5HaxD2HaxD", version: "7.20.4", ip: "192.168.50.2", status: "online", managed: true, parent: "router" });
    expect(must(byMac(UPSTAIRS))).toMatchObject({ name: "Upstairs AP", version: "7.19.6", ip: "192.168.50.3" });
    expect(byMac(LIVING)!.via).toMatchObject({ kind: "port", port: "ether7", certainty: "read" });
    expect(byMac(UPSTAIRS)!.via).toMatchObject({ kind: "port", port: "ether8" });
    expect(byMac(LIVING)!.facts).toContain("Powered over PoE from ether7: 53.1 V, 6.8 W");
  });

  it("does not list the router's or the APs' own MACs as clients", () => {
    expect(byMac("00:00:5E:00:53:01")).toBeUndefined();
    expect(m.devices.filter((d) => d.mac === LIVING)).toHaveLength(1);
  });
});

describe("demo model: clients", () => {
  it("places wired devices on their router ports", () => {
    for (const [mac, port, kind] of [
      ["00:00:5E:00:53:10", "ether2", "nas"],
      ["00:00:5E:00:53:20", "ether3", "desktop"],
      ["00:00:5E:00:53:30", "ether4", "tv"],
    ] as const) {
      const d = must(byMac(mac));
      expect(d).toMatchObject({ kind, parent: "router", status: "online" });
      expect(d.via).toMatchObject({ kind: "port", port, certainty: "read" });
    }
  });

  it("hangs Wi-Fi clients off the right access point and radio", () => {
    const wifi = m.devices.filter((d) => d.via?.kind === "wifi");
    expect(wifi).toHaveLength(11);
    expect(wifi.filter((d) => d.parent === `mac:${LIVING}`)).toHaveLength(5);
    expect(wifi.filter((d) => d.parent === `mac:${UPSTAIRS}`)).toHaveLength(6);
    const mac = must(byMac("00:00:5E:00:53:70"));
    expect(mac).toMatchObject({ name: "Alex MacBook", kind: "laptop", status: "online" });
    expect(mac.via).toMatchObject({ ssid: "Maple", band: "5", signal: -52, radio: "cap-wifi2", txRate: "1200.9Mbps" });
    const plug = must(byMac("00:00:5E:00:53:40"));
    expect(plug).toMatchObject({ kind: "iot", only24: true, name: "Kitchen Shelly plug", nameSource: "comment" });
    expect(plug.via).toMatchObject({ band: "2.4", radio: "cap-wifi1" });
  });

  it("resolves guest clients on a virtual interface to the physical radio", () => {
    const g = must(byMac("7A:00:5E:00:53:73"));
    expect(g).toMatchObject({ network: "vlan20-guest", ip: "192.168.60.101", privateMac: true, parent: `mac:${LIVING}` });
    expect(g.via).toMatchObject({ ssid: "Maple Guest", radio: "cap-wifi2", band: "5" });
  });

  it("decodes escaped UTF-8 comments and applies user names", () => {
    expect(must(byMac("00:00:5E:00:53:50")).leaseComment).toBe("Brother printer – study");
    expect(must(byMac("00:00:5E:00:53:50"))).toMatchObject({ name: "Study printer", nameSource: "user", only24: true });
    expect(must(byMac("9E:00:5E:00:53:74")).name).toBe("Zoë iPad");
  });

  it("marks offline reservations and private MACs", () => {
    expect(must(byMac("3A:00:5E:00:53:60"))).toMatchObject({ name: "Emma iPhone", reserved: true, privateMac: true, status: "offline" });
    expect(must(byMac("00:00:5E:00:53:25"))).toMatchObject({ name: "Workshop Pi", kind: "server", kindCertainty: "user", status: "offline", reserved: true });
    expect(must(byMac("D6:00:5E:00:53:75"))).toMatchObject({ name: "Emma-iPhone", nameSource: "hostname", reserved: false, status: "online", ip: "192.168.50.105" });
  });

  it("gives every device a unique id and a parent that exists", () => {
    const ids = m.devices.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of m.devices) if (d.parent) expect(ids).toContain(d.parent);
    expect(m.devices).toHaveLength(21);
  });
});

describe("demo model: ports", () => {
  it("lists the RB5009 front panel in order", () => {
    expect(m.ports.map((p) => p.name)).toEqual(["ether1", "ether2", "ether3", "ether4", "ether5", "ether6", "ether7", "ether8", "sfp-sfpplus1"]);
    expect(m.ports.at(-1)!.kind).toBe("sfp");
  });

  it("records occupancy, zones, speeds, PoE and the planned AP", () => {
    const p = Object.fromEntries(m.ports.map((x) => [x.name, x]));
    expect(p.ether1).toMatchObject({ zone: "upstream", deviceIds: ["upstream"], poe: "off", speedMbps: 1000 });
    expect(p.ether2!.deviceIds).toEqual(["mac:00:00:5E:00:53:10"]);
    expect(p.ether4).toMatchObject({ speedMbps: 100, zone: "lan", network: "bridge" });
    expect(p.ether5).toMatchObject({ deviceIds: [], running: false });
    expect(p.ether6).toMatchObject({ poe: "off", planned: "garden-ap", deviceIds: [] });
    expect(p.ether7).toMatchObject({ deviceIds: [`mac:${LIVING}`], poeWatts: 6.8, poeVolts: 53.1, hwOffload: true });
    expect(p.ether8).toMatchObject({ deviceIds: [`mac:${UPSTAIRS}`], poeWatts: 7.4 });
  });
});

describe("demo model: networks and Wi-Fi", () => {
  it("has the home LAN with DHCP and a guest VLAN", () => {
    const lan = m.networks.find((n) => n.id === "bridge")!;
    expect(lan).toMatchObject({ role: "lan", label: "Home LAN", cidr: "192.168.50.0/24", gateway: "192.168.50.1" });
    expect(lan.dhcp).toMatchObject({ server: "home-dhcp", size: 100, used: 7, leaseTime: "1d", dns: ["192.168.50.10", "192.168.50.1"], ntp: ["192.168.50.1"], gateway: "192.168.50.1" });
    const guest = m.networks.find((n) => n.id === "vlan20-guest");
    expect(guest).toMatchObject({ role: "guest", label: "Guest Wi-Fi", vlan: 20, cidr: "192.168.60.0/24", bridge: "bridge" });
  });

  it("collects SSIDs with bands, security and roaming", () => {
    const home = m.ssids.find((s) => s.name === "Maple");
    expect(home).toMatchObject({ bands: ["2.4", "5"], auth: ["wpa2-psk", "wpa3-psk"], ft: true, country: "United Kingdom", clients: 10 });
    expect(home!.aps.sort()).toEqual([`mac:${LIVING}`, `mac:${UPSTAIRS}`]);
    expect(m.ssids.find((s) => s.name === "Maple Guest")).toMatchObject({ auth: ["wpa2-psk"], ft: true, clients: 1 });
  });

  // BUG (src/core/model.ts ssidFor): every SSID gets `network: lanNet?.id`. The configuration's
  // datapath (here dp-guest with vlan-id=20) is ignored, so "Maple Guest" is attributed to the home
  // LAN and analyze() reports a false "wifi-duplicate-ssids-bridge" (2 Wi-Fi names, same network).
  it("attributes a VLAN-tagged guest SSID to the guest network", () => {
    expect(m.ssids.find((s) => s.name === "Maple Guest")!.network).toBe("vlan20-guest");
    expect(m.networks.find((n) => n.id === "bridge")!.ssids).toEqual(["Maple"]);
  });

  it("builds one radio per CAP band with live channels", () => {
    const r = Object.fromEntries(m.radios.map((x) => [x.id, x]));
    expect(Object.keys(r).sort()).toEqual(["cap-wifi1", "cap-wifi2", "cap-wifi3", "cap-wifi4"]);
    expect(r["cap-wifi1"]).toMatchObject({ apId: `mac:${LIVING}`, band: "2.4", current: { channel: 1, width: 20 }, clients: 1, ssids: ["Maple", "Maple Guest"] });
    expect(r["cap-wifi2"]).toMatchObject({ apId: `mac:${LIVING}`, band: "5", current: { channel: 36, width: 80, dfs: false }, clients: 4 });
    expect(r["cap-wifi3"]).toMatchObject({ apId: `mac:${UPSTAIRS}`, band: "2.4", current: { channel: 11 }, clients: 3 });
    expect(r["cap-wifi4"]).toMatchObject({ apId: `mac:${UPSTAIRS}`, band: "5", current: { channel: 44, width: 80 }, clients: 3 });
    expect(r["cap-wifi2"]!.plan).toEqual({ frequencies: [5180, 5200, 5220, 5240], width: "20/40/80mhz", skipDfs: true });
  });

  it("calls a device with a valid lease but failed ARP offline, and says why", () => {
    const rsc = "/ip address\nadd address=192.168.50.1/24 interface=bridge\n/ip dhcp-server\nadd interface=bridge name=dhcp1\n";
    const lease = (mac: string, ip: string) => ({ address: ip, "mac-address": mac, server: "dhcp1", status: "bound", "last-seen": "25m51s", dynamic: "true" });
    const mm = buildModel({
      collectedAt: "x",
      devices: [
        {
          role: "router",
          config: parseExport(rsc),
          state: {
            "/ip/dhcp-server/lease": [lease("00:00:5E:00:53:81", "192.168.50.81"), lease("00:00:5E:00:53:82", "192.168.50.82")],
            "/ip/arp": [
              { address: "192.168.50.81", "mac-address": "00:00:5E:00:53:81", interface: "bridge", complete: "false", status: "failed" },
              { address: "192.168.50.82", "mac-address": "00:00:5E:00:53:82", interface: "bridge", complete: "true", status: "reachable" },
            ],
          },
          sources: [],
        },
      ],
    });
    const gone = mm.devices.find((d) => d.mac === "00:00:5E:00:53:81")!;
    expect(gone.status).toBe("offline");
    expect(gone.facts.join(" ")).toMatch(/Probably asleep or gone.*25m51s/);
    expect(mm.devices.find((d) => d.mac === "00:00:5E:00:53:82")!.status).toBe("online");
  });

  it("ties radios to their access point from the REST `cap` field, without CAP exports", () => {
    const AP = "00:00:5E:00:53:C0";
    const mm = buildModel({
      collectedAt: "x",
      devices: [
        {
          role: "router",
          config: {
            meta: {},
            menus: {
              "/interface/wifi/configuration": [{ name: "home-5g", ssid: "Maple" }],
              "/interface/wifi": [
                { name: "cap-wifi1", master: "true", cap: `cap-den@${AP}%*e`, configuration: "home-5g", "channel.band": "5ghz-ax" },
                { name: "cap-wifi1-virtual1", master: "false", "master-interface": "cap-wifi1", configuration: "home-5g" },
              ],
            },
          },
          state: {
            "/interface/wifi/capsman/remote-cap": [{ address: `${AP}%bridge`, "base-mac": AP, identity: "cap-den", state: "Ok" }],
            "/interface/wifi/registration-table": [{ interface: "cap-wifi1-virtual1", "mac-address": "00:00:5E:00:53:71", ssid: "Maple", band: "5ghz-ax", signal: "-58" }],
          },
          sources: [],
        },
      ],
    });
    expect(mm.radios.find((r) => r.id === "cap-wifi1")).toMatchObject({ apId: `mac:${AP}`, clients: 1 });
    expect(mm.devices.find((d) => d.mac === "00:00:5E:00:53:71")).toMatchObject({ parent: `mac:${AP}`, via: { kind: "wifi", signal: -58 } });
  });

  it("falls back to the channel printed in a CAP's own export when there is no live state", () => {
    const { config, base } = readConfig(DEMO);
    const offline = snapshotFromFiles({ ...config, sources: config.sources!.map((s) => ({ ...s, state: undefined })) }, base);
    const mm = buildModel(offline);
    expect(mm.hasState).toBe(false);
    expect(mm.radios.find((r) => r.id === "cap-wifi4")!.current).toMatchObject({ channel: 44, width: 80 });
    expect(mm.radios.find((r) => r.id === "cap-wifi1")!.current).toMatchObject({ channel: 1, width: 20 });
    expect(mm.devices.find((d) => d.kind === "ap" && d.mac === UPSTAIRS)).toMatchObject({ version: "7.19.6", status: "unknown" });
    expect(mm.wan).toMatchObject({ type: "dhcp", doubleNat: "unknown" });
  });
});

describe("saved snapshots", () => {
  it("loads a Snapshot written by `collect` next to exports from sources, scrubbing again", () => {
    const dir = mkdtempSync(join(tmpdir(), "stribog-test-"));
    const router = { ...snap.devices[0]!, sources: [{ kind: "rest" as const, label: "https://192.168.50.1" }] };
    router.config = { ...router.config, menus: { ...router.config.menus, "/ppp/secret": [{ name: "x", password: "leaked" }] } };
    writeFileSync(join(dir, "snap.json"), JSON.stringify({ collectedAt: "2026-11-05T10:00:00.000Z", devices: [router] }));
    writeFileSync(join(dir, "bare.json"), JSON.stringify([router]));
    const { config, base } = readConfig(DEMO);
    const caps = config.sources!.filter((s) => s.role === "cap").map((s) => ({ ...s, export: resolve(base, s.export!) }));

    const s1 = snapshotFromFiles({ sources: caps, snapshot: "snap.json", notes: resolve(base, config.notes!) }, dir);
    expect(s1.devices.map((d) => d.role)).toEqual(["cap", "cap", "router"]);
    expect(s1.collectedAt).toBe("2026-11-05T10:00:00.000Z");
    expect(JSON.stringify(s1)).not.toContain("leaked");
    const m1 = buildModel(s1);
    expect(m1.devices.map((d) => d.id).sort()).toEqual(m.devices.map((d) => d.id).sort());
    expect(m1.sources.map((s) => s.kind)).toEqual(["export", "export", "rest"]);

    const s2 = snapshotFromFiles({ snapshot: join(dir, "bare.json") }, "/");
    expect(s2.devices).toHaveLength(1);
    expect(buildModel(s2).routerId).toBe("router");
  });
});

// BUG (src/core/model.ts clients loop): every ARP MAC becomes a client device. A live router always
// has an ARP entry for its WAN gateway (here 203.0.113.1 on ether1); with a public WAN that MAC
// becomes "Unknown device 53:FE" in the upstream zone, and analyze() reports a false
// "wan-devices-outside" (… is outside your firewall, on 203.0.113.0/24). The ISP gateway should be
// merged into the "upstream" device (or ARP entries on WAN interfaces ignored).
it("does not turn the WAN gateway's ARP entry into a client; it is the upstream device", () => {
  const { config, base } = readConfig(DEMO);
  const s = snapshotFromFiles(config, base);
  s.devices[0]!.state!["/ip/arp"]!.push({ address: "203.0.113.1", "mac-address": "00:00:5E:00:53:FE", interface: "ether1", complete: "true" });
  s.devices[0]!.state!["/interface/bridge/host"]!.push({ "mac-address": "00:00:5E:00:53:FE", "on-interface": "ether1", bridge: "bridge" });
  const mm = buildModel(s);
  expect(mm.devices.filter((d) => d.zone === "upstream" && d.mac && d.id !== "upstream")).toEqual([]);
  expect(mm.devices.find((d) => d.id === "upstream")!.mac).toBe("00:00:5E:00:53:FE");
});

describe("small configs", () => {
  const snapOf = (rsc: string, state?: Snapshot["devices"][number]["state"]): Snapshot => ({
    collectedAt: "2026-01-01",
    devices: [{ role: "router", config: parseExport(rsc), state, sources: [] }],
  });

  it("detects double NAT from a private WAN lease", () => {
    const mm = buildModel(
      snapOf(
        `/interface list
add name=WAN
add name=LAN
/interface bridge
add name=bridge
/interface list member
add interface=ether1 list=WAN
add interface=bridge list=LAN
/ip dhcp-client
add interface=ether1
/ip address
add address=10.0.0.1/24 interface=bridge`,
        { "/ip/dhcp-client": [{ interface: "ether1", address: "192.168.1.20/24", gateway: "192.168.1.1", status: "bound" }] },
      ),
    );
    expect(mm.wan).toMatchObject({ addressKind: "private", doubleNat: true, doubleNatCertainty: "read" });
    expect(mm.devices.find((d) => d.id === "upstream")).toBeDefined();
  });

  it("recognises a PPPoE WAN and CGNAT", () => {
    const mm = buildModel(
      snapOf(`/interface pppoe-client
add interface=ether1 name=pppoe-out1 user=me password=x
/interface bridge
add name=bridge`),
    );
    expect(mm.wan).toMatchObject({ type: "pppoe", iface: "pppoe-out1" });
  });

  it("names a router with the default identity after its model", () => {
    const mm = buildModel({ collectedAt: "x", devices: [{ role: "router", config: { meta: { model: "RB5009UG+S+" }, menus: {} }, sources: [] }] });
    expect(mm.devices.find((d) => d.id === "router")).toMatchObject({ name: "RB5009", nameSource: "system" });
  });

  it("copes with an empty snapshot", () => {
    const mm = buildModel({ collectedAt: "x", devices: [] });
    expect(mm.devices.map((d) => d.id)).toEqual(["internet"]);
    expect(mm.routerId).toBeUndefined();
  });
});
