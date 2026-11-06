import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { layoutTopology, orbitRadius, type Layout } from "../src/core/layout.ts";
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
  for (const o of l.orbits) expect(finite(o.x) && finite(o.y)).toBe(true);
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

  it("puts Wi-Fi clients in an orbit around their AP, further out when weaker", () => {
    expect(l.orbits.map((o) => o.apId).sort()).toEqual(["mac:00:00:5E:00:53:A0", "mac:00:00:5E:00:53:B0"]);
    for (const d of m.devices.filter((x) => x.via?.kind === "wifi")) {
      const n = l.nodes.find((x) => x.id === d.id)!;
      const o = l.orbits.find((x) => x.apId === d.parent)!;
      expect(n.client).toBe(true);
      expect(Math.hypot(n.x - o.x, n.y - o.y)).toBeCloseTo(orbitRadius(d.via?.signal), 5);
    }
    expect(orbitRadius(-48)).toBeLessThan(orbitRadius(-76));
    expect(orbitRadius(-30)).toBe(orbitRadius(-40));
    expect(orbitRadius(-95)).toBe(orbitRadius(-99));
  });

  it("keeps the two AP orbits apart", () => {
    const [a, b] = l.orbits;
    const maxR = (o: typeof a) => Math.max(...l.nodes.filter((n) => n.client && m.devices.find((d) => d.id === n.id)?.parent === o!.apId).map((n) => Math.hypot(n.x - o!.x, n.y - o!.y)));
    expect(Math.abs(a!.x - b!.x)).toBeGreaterThan(maxR(a) + maxR(b));
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
    expect(l.links.find((x) => x.to === "planned:garden-ap")).toMatchObject({ medium: "planned", weight: 0 });
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

  it("packs many devices on the ISP network into a grid without a link each", () => {
    const rsc = `/interface bridge
add name=bridge comment="WAN to ISP"
add name=lan
/interface list
add name=WAN
/interface list member
add interface=bridge list=WAN
/interface bridge port
add bridge=bridge interface=ether1
add bridge=lan interface=ether2
/ip address
add address=10.0.0.1/24 interface=lan
/ip dhcp-client
add interface=bridge
`;
    const arp = Array.from({ length: 17 }, (_, i) => ({ address: `192.168.1.${30 + i}`, "mac-address": `00:00:5E:00:53:${(0x60 + i).toString(16).toUpperCase()}`, interface: "bridge", complete: "true" }));
    const m = buildModel({
      collectedAt: "x",
      devices: [{ role: "router", config: parseExport(rsc), state: { "/ip/dhcp-client": [{ interface: "bridge", address: "192.168.1.20/24", gateway: "192.168.1.1" }], "/ip/arp": arp }, sources: [] }],
    });
    const l = layoutTopology(m);
    checkSane(m, l);
    const legacy = l.nodes.filter((n) => n.id.startsWith("mac:"));
    expect(legacy).toHaveLength(17);
    expect(new Set(legacy.map((n) => n.x)).size).toBe(6);
    expect(new Set(legacy.map((n) => n.y)).size).toBe(3);
    expect(l.links.filter((x) => x.to.startsWith("mac:"))).toEqual([]);
    // The grid stays above the router and inside its zone.
    const z = l.zones[0]!;
    const router = l.nodes.find((n) => n.id === m.routerId)!;
    for (const n of legacy) {
      expect(n.y + 60).toBeLessThan(router.y - 31);
      expect(n.x).toBeGreaterThan(z.x);
      expect(n.y + 45).toBeLessThan(z.y + z.h);
    }
    expect(z.sub).toContain("17 devices not behind this router");
  });
});
