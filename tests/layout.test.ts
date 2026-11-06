import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { layoutTopology, UPSTREAM_GROUP, type Layout } from "../src/core/layout.ts";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { buildModel, type NetworkModel } from "../src/core/model.ts";
import { parseExport } from "../src/core/ros.ts";

const DEMO = resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json");

function demoModel(): NetworkModel {
  const { config, base } = readConfig(DEMO);
  return buildModel(snapshotFromFiles(config, base));
}

const finite = (n: number) => Number.isFinite(n);

function checkSane(m: NetworkModel, l: Layout) {
  for (const n of l.nodes) {
    expect(finite(n.x) && finite(n.y), `${n.id} at ${n.x},${n.y}`).toBe(true);
  }
  for (const k of ["x", "y", "w", "h"] as const) expect(finite(l.bounds[k])).toBe(true);
  for (const link of l.links) expect(link.d, link.id).not.toMatch(/NaN|undefined|Infinity/);
  // Bounds contain every node and zone.
  const { x, y, w, h } = l.bounds;
  for (const n of l.nodes) {
    expect(n.x, n.id).toBeGreaterThanOrEqual(x);
    expect(n.x, n.id).toBeLessThanOrEqual(x + w);
    expect(n.y, n.id).toBeGreaterThanOrEqual(y);
    expect(n.y, n.id).toBeLessThanOrEqual(y + h);
  }
  for (const z of l.zones) {
    expect(z.x).toBeGreaterThanOrEqual(x);
    expect(z.x + z.w).toBeLessThanOrEqual(x + w);
  }
  // Every node id once; every link endpoint exists.
  const ids = l.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const link of l.links) {
    expect(ids, link.id).toContain(link.from);
    expect(ids, link.id).toContain(link.to);
  }
  void m;
}

describe("layout: demo network", () => {
  const m = demoModel();
  const l = layoutTopology(m);

  it("has finite coordinates, unique nodes and bounds around everything", () => {
    checkSane(m, l);
  });

  it("draws every placed device exactly once, plus planned ghosts", () => {
    const ids = l.nodes.map((n) => n.id);
    const placed = m.devices.filter((d) => d.id === "internet" || d.parent);
    for (const d of placed) expect(ids.filter((i) => i === d.id), d.id).toHaveLength(1);
    expect(ids).toContain("planned:garden-ap");
    expect(l.nodes.find((n) => n.id === "planned:garden-ap")!.ghost).toBe(true);
    // Offline reservations without a known place are not drawn.
    expect(ids).not.toContain("mac:3A:00:5E:00:53:60");
  });

  it("orders gateway children by port left to right, so links never cross", () => {
    const tier1 = m.devices.filter((d) => d.parent === m.routerId && d.zone !== "upstream");
    const slots = [
      ...tier1.map((d) => ({ id: d.id, port: d.via?.port })),
      ...m.planned.map((p) => ({ id: `planned:${p.id}`, port: p.port })),
    ];
    const portIdx = (p?: string) => m.ports.findIndex((x) => x.name === p);
    const byPort = [...slots].sort((a, b) => portIdx(a.port) - portIdx(b.port));
    const xOf = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    const xs = byPort.map((s) => xOf(s.id));
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(byPort.map((s) => s.port)).toEqual(["ether2", "ether3", "ether4", "ether6", "ether7", "ether8"]);
    // Port x positions on the gateway increase in the same order.
    const px = byPort.map((s) => l.portX[s.port!]!);
    expect([...px].sort((a, b) => a - b)).toEqual(px);
  });

  it("puts devices behind an AP into one cluster per medium, each with its own coloured line", () => {
    for (const apId of ["mac:00:00:5E:00:53:A0", "mac:00:00:5E:00:53:B0"]) {
      const ap = l.nodes.find((n) => n.id === apId)!;
      const kids = m.devices.filter((d) => d.parent === apId);
      const mediumOfKid = (d: (typeof kids)[number]) => (d.via?.kind === "wifi" ? `wifi-${d.via.band}` : "wired");
      const groups = new Map<string, typeof kids>();
      for (const d of kids) groups.set(mediumOfKid(d), [...(groups.get(mediumOfKid(d)) ?? []), d]);
      const buses = l.buses.filter((b) => b.from === apId);
      expect(buses).toHaveLength(groups.size);

      const spans: [number, number][] = [];
      for (const [medium, ds] of groups) {
        const bus = buses.find((b) => (medium === "wired" ? !b.medium.startsWith("wifi") : b.medium === medium))!;
        expect(bus.label).toMatch(medium === "wired" ? /^Cable · \S+$/ : new RegExp(`^${medium.replace("wifi-", "").replace(".", "\\.")} GHz Wi-Fi · ${ds.length}$`));
        const placed = ds.map((d) => ({ d, n: l.nodes.find((x) => x.id === d.id)! }));
        for (const { d, n } of placed) {
          expect(n.y, d.name).toBeGreaterThan(ap.y + 100);
          const link = l.links.find((x) => x.to === d.id)!;
          expect(link.from).toBe(apId);
          if (d.via?.kind === "wifi") expect(link.medium).toBe(medium);
        }
        // Inside a Wi-Fi cluster, reading order goes from the strongest signal down.
        const order = placed.sort((a, b) => a.n.y - b.n.y || a.n.x - b.n.x).map((p) => p.d.via?.signal ?? -99);
        if (medium !== "wired") expect([...order].sort((a, b) => b - a)).toEqual(order);
        spans.push([Math.min(...placed.map((p) => p.n.x)), Math.max(...placed.map((p) => p.n.x))]);
      }
      // Clusters sit side by side, never interleaved.
      spans.sort((a, b) => a[0] - b[0]);
      for (let k = 1; k < spans.length; k++) expect(spans[k]![0]).toBeGreaterThan(spans[k - 1]![1] + 100);
    }
  });

  it("keeps the devices of two APs from overlapping", () => {
    const xs = (apId: string) => l.nodes.filter((n) => m.devices.find((d) => d.id === n.id)?.parent === apId).map((n) => n.x);
    const a = xs("mac:00:00:5E:00:53:A0");
    const b = xs("mac:00:00:5E:00:53:B0");
    expect(Math.max(...a) + 140).toBeLessThan(Math.min(...b));
  });

  it("stacks the spine: internet above the ONT above the gateway above its children", () => {
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y;
    expect(y("internet")).toBeLessThan(y("upstream"));
    expect(y("upstream")).toBeLessThan(y("router"));
    expect(y("router")).toBeLessThan(y("mac:00:00:5E:00:53:10"));
    const wan = l.links.find((x) => x.id === "l:router")!;
    expect(wan).toMatchObject({ from: "upstream", medium: "wan" });
    expect(wan.label).toBe("ether1 · 1G");
  });

  it("labels links with port, speed and PoE", () => {
    expect(l.links.find((x) => x.to === "mac:00:00:5E:00:53:A0")!.label).toBe("ether7 · 1G · PoE 6.8 W");
    expect(l.links.find((x) => x.to === "mac:00:00:5E:00:53:30")).toMatchObject({ label: "ether4 · 100M", medium: "100m" });
    expect(l.links.find((x) => x.to === "planned:garden-ap")).toMatchObject({ medium: "planned" });
    expect(l.links.find((x) => x.to === "planned:garden-ap")!.down).toBeUndefined();
  });
});

describe("layout: edge cases", () => {
  it("lays out a model with only the internet", () => {
    const l = layoutTopology(buildModel({ collectedAt: "x", devices: [] }));
    expect(l.nodes.map((n) => n.id)).toEqual(["internet"]);
    expect(finite(l.bounds.w) && l.bounds.w > 0).toBe(true);
  });

  it("lays out a router without state, ports or clients", () => {
    const m = buildModel({ collectedAt: "x", devices: [{ role: "router", config: parseExport("/system identity\nset name=gw\n"), sources: [] }] });
    const l = layoutTopology(m);
    checkSane(m, l);
    expect(l.nodes.map((n) => n.id).sort()).toEqual(["internet", "router"]);
  });

  it("lays out a double-NAT setup with devices left on the ISP network", () => {
    const rsc = `/interface bridge
add name=bridge comment="WAN to ISP"
add name=lan
/interface list
add name=WAN
add name=LAN
/interface list member
add interface=bridge list=WAN
add interface=lan list=LAN
/interface bridge port
add bridge=bridge interface=ether1
add bridge=lan interface=ether2
/ip address
add address=10.0.0.1/24 interface=lan
/ip dhcp-client
add interface=bridge
`;
    const m = buildModel({
      collectedAt: "x",
      devices: [
        {
          role: "router",
          config: parseExport(rsc),
          state: {
            "/ip/dhcp-client": [{ interface: "bridge", address: "192.168.1.20/24", gateway: "192.168.1.1" }],
            "/ip/arp": [
              { address: "192.168.1.30", "mac-address": "00:00:5E:00:53:31", interface: "bridge", complete: "true" },
              { address: "192.168.1.31", "mac-address": "00:00:5E:00:53:32", interface: "bridge", complete: "true" },
            ],
            "/interface/bridge/host": [{ "mac-address": "00:00:5E:00:53:40", "on-interface": "ether2", bridge: "lan" }],
          },
          sources: [],
        },
      ],
    });
    const l = layoutTopology(m);
    checkSane(m, l);
    expect(l.zones).toHaveLength(1);
    expect(l.zones[0]!.sub).toContain("192.168.1.0/24");
    expect(l.links.find((x) => x.id === "l:router")!.label).toContain("double NAT");
  });

  it("stands one group node for devices seen only on the ISP network, without a link each", () => {
    const rsc = `/interface bridge
add name=wan-br
add name=lan
/interface list
add name=WAN
/interface list member
add interface=wan-br list=WAN
/interface bridge port
add bridge=wan-br interface=ether1
add bridge=lan interface=ether2
/ip address
add address=10.0.0.1/24 interface=lan
/ip dhcp-client
add interface=wan-br
`;
    const arp = Array.from({ length: 17 }, (_, i) => ({ address: `192.168.1.${30 + i}`, "mac-address": `00:00:5E:00:53:${(0x60 + i).toString(16).toUpperCase()}`, interface: "wan-br", complete: "true", status: i < 2 ? "reachable" : "stale" }));
    const m = buildModel({
      collectedAt: "x",
      devices: [{ role: "router", config: parseExport(rsc), state: { "/ip/dhcp-client": [{ interface: "wan-br", address: "192.168.1.20/24", gateway: "192.168.1.1" }], "/ip/arp": arp }, sources: [] }],
    });
    const l = layoutTopology(m);
    checkSane(m, l);
    expect(l.nodes.filter((n) => n.id.startsWith("mac:"))).toEqual([]);
    expect(l.nodes.find((n) => n.id === UPSTREAM_GROUP)).toMatchObject({ kind: "group" });
    expect(l.links.filter((x) => x.to === UPSTREAM_GROUP)).toEqual([]);
    expect(m.devices.filter((d) => d.zone === "upstream" && d.status === "online" && d.id !== "upstream")).toHaveLength(2);
  });
});

describe("layout: a busy access point", () => {
  // One CAP with nine 5 GHz clients and two on 2.4 GHz, read the way REST reports it.
  const AP = "00:00:5E:00:53:C0";
  const reg = (i: number, iface: string, band: string) => ({ interface: iface, "mac-address": `00:00:5E:00:53:${(0x80 + i).toString(16).toUpperCase()}`, band, signal: String(-40 - i * 3) });
  const m = buildModel({
    collectedAt: "x",
    devices: [
      {
        role: "router",
        config: {
          meta: {},
          menus: {
            "/interface/wifi/configuration": [{ name: "c5", ssid: "Maple" }, { name: "c2", ssid: "Maple" }],
            "/interface/wifi": [
              { name: "cap-wifi1", master: "true", cap: `cap-den@${AP}%*e`, configuration: "c5", "channel.band": "5ghz-ax" },
              { name: "cap-wifi2", master: "true", cap: `cap-den@${AP}%*e`, configuration: "c2", "channel.band": "2ghz-ax" },
            ],
          },
        },
        state: {
          "/interface/wifi/capsman/remote-cap": [{ address: `${AP}%bridge`, "base-mac": AP, identity: "cap-den", state: "Ok" }],
          "/interface/wifi/registration-table": [...Array.from({ length: 9 }, (_, i) => reg(i, "cap-wifi1", "5ghz-ax")), reg(9, "cap-wifi2", "2ghz-ax"), reg(10, "cap-wifi2", "2ghz-ax")],
        },
        sources: [],
      },
    ],
  });
  const l = layoutTopology(m);

  it("draws one tree per band whose centre line runs between devices, never through one", () => {
    checkSane(m, l);
    const buses = l.buses.filter((b) => b.from === `mac:${AP}`);
    expect(buses.map((b) => b.label).sort()).toEqual(["2.4 GHz Wi-Fi · 2", "5 GHz Wi-Fi · 9"]);
    const five = m.devices.filter((d) => d.via?.band === "5").map((d) => l.nodes.find((n) => n.id === d.id)!);
    const rows = [...new Set(five.map((n) => n.y))].sort((a, b) => a - b);
    expect(rows).toHaveLength(3);
    const firstRow = five.filter((n) => n.y === rows[0]);
    const centre = (Math.min(...firstRow.map((n) => n.x)) + Math.max(...firstRow.map((n) => n.x))) / 2;
    // Every row but the last is crossed by the centre line; none of its devices may sit on it.
    for (const n of five.filter((x) => x.y !== rows.at(-1))) expect(Math.abs(n.x - centre)).toBeGreaterThan(60);
  });
});

describe("layout: traffic", () => {
  const { config, base } = readConfig(DEMO);
  const m = buildModel(snapshotFromFiles(config, base));
  const l = layoutTopology(m);
  it("carries traffic on links: down is towards the device, and the WAN link counts what comes in", () => {
    const wan = m.ports.find((p) => p.name === m.devices.find((d) => d.id === m.routerId)!.via!.port)!;
    expect(l.links.find((x) => x.id === `l:${m.routerId}`)).toMatchObject({ down: wan.rxBps, up: wan.txBps });
    const nas = m.devices.find((d) => d.mac === "00:00:5E:00:53:10")!;
    const port = m.ports.find((p) => p.name === nas.via!.port)!;
    expect(l.links.find((x) => x.to === nas.id)).toMatchObject({ down: port.txBps, up: port.rxBps });
    const laptop = m.devices.find((d) => d.mac === "00:00:5E:00:53:70")!;
    expect(l.links.find((x) => x.to === laptop.id)).toMatchObject({ down: 38_400_000, up: 1_900_000 });
  });
  it("sums a cluster's Wi-Fi traffic onto its line", () => {
    const laptop = m.devices.find((d) => d.mac === "00:00:5E:00:53:70")!;
    const bus = l.buses.find((b) => b.from === laptop.parent && b.medium === "wifi-5")!;
    const kids = m.devices.filter((d) => d.parent === laptop.parent && d.via?.band === "5");
    expect(bus.down).toBe(kids.reduce((t, d) => t + (d.via?.downBps ?? 0), 0));
    expect(bus.trunk).toMatch(/^M /);
  });
});
