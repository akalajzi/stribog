// The upstream side of an unknown network, read only from structure: interface lists, bridges,
// the DHCP client, ARP state and the bridge host table. No comments, no names.

import { describe, expect, it } from "vitest";
import { analyze } from "../src/core/analyze.ts";
import { layoutTopology, UPSTREAM_GROUP } from "../src/core/layout.ts";
import { buildModel } from "../src/core/model.ts";
import { parseExport, type RosRecord } from "../src/core/ros.ts";

const RSC = `/interface bridge
add name=wan-br
add name=lan
/interface list
add name=WAN
add name=LAN
/interface list member
add interface=wan-br list=WAN
add interface=lan list=LAN
/interface bridge port
add bridge=wan-br interface=ether1
add bridge=wan-br interface=ether5
add bridge=lan interface=ether2
add bridge=lan interface=ether3
/ip address
add address=10.0.0.1/24 interface=lan
add address=192.168.1.70/32 interface=wan-br
/ip pool
add name=p ranges=10.0.0.100-10.0.0.199
/ip dhcp-server
add address-pool=p interface=lan name=d
/ip dhcp-client
add interface=wan-br
/ip firewall nat
add action=masquerade chain=srcnat out-interface-list=WAN
add action=dst-nat chain=dstnat dst-address=192.168.1.70 to-addresses=10.0.0.70
`;

const GW = "00:00:5E:00:53:01";
const MOVED = "00:00:5E:00:53:50";
const HERE = "00:00:5E:00:53:61";
const GONE = "00:00:5E:00:53:62";
const PLUGGED = "00:00:5E:00:53:77";
const SERVER = "00:00:5E:00:53:3C";

function network(arpStatus: { here: string; plugged?: string } = { here: "reachable" }) {
  const arp = (address: string, mac: string, iface: string, status: string): RosRecord => ({ address, "mac-address": mac, interface: iface, status, complete: status === "failed" ? "false" : "true" });
  const state: Record<string, RosRecord[]> = {
    "/ip/dhcp-client": [{ interface: "wan-br", address: "192.168.1.20/24", gateway: "192.168.1.1", status: "bound" }],
    "/ip/arp": [
      arp("192.168.1.1", GW, "wan-br", "reachable"),
      arp("192.168.1.50", MOVED, "wan-br", "stale"),
      arp("10.0.0.50", MOVED, "lan", "reachable"),
      arp("192.168.1.61", HERE, "wan-br", arpStatus.here),
      arp("192.168.1.62", GONE, "wan-br", "failed"),
      arp("192.168.1.77", PLUGGED, "wan-br", arpStatus.plugged ?? "reachable"),
      arp("10.0.0.70", SERVER, "lan", "reachable"),
    ],
    "/ip/dhcp-server/lease": [{ address: "10.0.0.50", "mac-address": MOVED, server: "d", status: "bound", dynamic: "true" }],
    "/interface/bridge/host": [
      { "mac-address": GW, "on-interface": "ether1", bridge: "wan-br" },
      ...(arpStatus.plugged ? [] : [{ "mac-address": PLUGGED, "on-interface": "ether5", bridge: "wan-br" }]),
      { "mac-address": MOVED, "on-interface": "ether2", bridge: "lan" },
      { "mac-address": SERVER, "on-interface": "ether3", bridge: "lan" },
    ],
    "/interface/ethernet/monitor": [
      { name: "ether1", status: "link-ok", rate: "1Gbps" },
      { name: "ether5", status: "link-ok", rate: "1Gbps" },
    ],
  };
  const snap = { collectedAt: "x", devices: [{ role: "router" as const, config: parseExport(RSC), state, sources: [] }] };
  const m = buildModel(snap);
  return { m, a: analyze(m, snap), byMac: (mac: string) => m.devices.find((d) => d.mac === mac && d.id !== "upstream") };
}

describe("upstream side, from structure alone", () => {
  it("makes the gateway the upstream device and finds the uplink port from where its MAC is learned", () => {
    const { m, byMac } = network();
    const up = m.devices.find((d) => d.id === "upstream")!;
    expect(up).toMatchObject({ mac: GW, name: "ISP router", ip: "192.168.1.1" });
    expect(byMac(GW)).toBeUndefined();
    expect(m.devices.find((d) => d.id === m.routerId)!.via?.port).toBe("ether1");
    expect(m.ports.find((p) => p.name === "ether1")!.deviceIds).toContain("upstream");
  });

  it("keeps a device that moved to the LAN on the LAN, with its old upstream address as a fact", () => {
    const d = network().byMac(MOVED)!;
    expect(d).toMatchObject({ zone: "lan", ip: "10.0.0.50", status: "online" });
    expect(d.facts).toContain("Also known on the upstream network as 192.168.1.50 (not heard from recently)");
  });

  it("puts devices seen only upstream there, online only when ARP says they answer", () => {
    const { byMac } = network();
    expect(byMac(HERE)).toMatchObject({ zone: "upstream", status: "online", parent: "upstream" });
    expect(byMac(GONE)).toMatchObject({ zone: "upstream", status: "offline", parent: "upstream" });
  });

  it("hangs a device on a WAN-side router port off that port", () => {
    const { m, byMac } = network();
    expect(byMac(PLUGGED)).toMatchObject({ zone: "upstream", parent: m.routerId, via: { kind: "port", port: "ether5", certainty: "read" } });
    const l = layoutTopology(m);
    expect(l.nodes.map((n) => n.id)).toContain(`mac:${PLUGGED}`);
    expect(l.nodes.map((n) => n.id)).toContain(UPSTREAM_GROUP);
    expect(l.nodes.map((n) => n.id)).not.toContain(`mac:${HERE}`);
  });

  it("reports devices present upstream, and only remembers the rest", () => {
    const now = network().a.findings.find((f) => f.id === "wan-devices-outside")!;
    expect(now).toMatchObject({ severity: "suggestion" });
    expect(now.title).toBe("2 devices on the ISP router's network");
    expect(now.evidence).toContain("Unknown device 53:62: 192.168.1.62, not answering recently");

    const q = network({ here: "stale", plugged: "failed" }).a.findings.find((f) => f.id === "wan-devices-outside")!;
    expect(q).toMatchObject({ severity: "info", title: "The router remembers 3 devices from the ISP router's network" });
  });

  it("finds extra WAN-side addresses forwarded into the LAN without reading any comment", () => {
    const f = network().a.findings.find((x) => x.id === "lan-legacy-compat")!;
    expect(f.title).toBe("The router answers for 1 extra address on the upstream network");
    expect(f.evidence).toEqual(["192.168.1.70 → 10.0.0.70 (Unknown device 53:3C)"]);
    expect(f.reads).toEqual(expect.arrayContaining(["router /ip/address", "router /ip/firewall/nat"]));
  });
});
