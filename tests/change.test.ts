// Changes to a set-up router: only the commands for what was chosen, with an undo, never a secret.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changeContext, defaultChangeOptions, generateChange, type ChangeOptions } from "../src/core/change.ts";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { buildModel } from "../src/core/model.ts";
import type { Snapshot } from "../src/core/ros.ts";

const DEMO = resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json");
const { config, base } = readConfig(DEMO);
const snap = snapshotFromFiles(config, base);
const ctxOf = (s: Snapshot) => changeContext(s, buildModel(s));
const ctx = ctxOf(snap);
const opts = (patch: (o: ChangeOptions) => void, c = ctx) => {
  const o = defaultChangeOptions(c);
  patch(o);
  return o;
};

describe("what a change needs from the router", () => {
  it("reads the bridge, the WAN, the access point ports and the main Wi-Fi", () => {
    expect(ctx.blocked).toBeUndefined();
    expect(ctx).toMatchObject({ bridge: "bridge", vlanFiltering: true, lan: "192.168.50.0/24", apPorts: ["ether7", "ether8"], wan: { list: true, iface: "ether1" }, natCoversAll: true });
    expect(ctx.wifi?.main).toMatchObject({ ssid: "Maple", configs: ["home-2g", "home-5g"], security: "wpa2-wpa3", secProfiles: ["sec-home"], ch5Profiles: ["ch-5g"], skipDfs: "all" });
  });

  it("knows the guest network is already there, and says it recognised it by name", () => {
    expect(ctx.existing.guest).toMatchObject({ iface: "vlan20-guest", vlan: 20, inferred: true });
    expect(ctx.read.find((r) => r.text.startsWith("Guest network already there"))?.inferred).toBe(true);
  });

  it("starts from free VLANs and subnets", () => {
    const o = defaultChangeOptions(ctx);
    expect(ctx.taken.vlans).not.toContain(o.iot.vlan);
    expect(o.iot).toMatchObject({ vlan: 30, subnet: "192.168.30.0/24" });
  });

  it("is blocked without a configuration", () => {
    expect(changeContext({ collectedAt: "", devices: [] }, buildModel({ collectedAt: "", devices: [] })).blocked).toMatch(/no configuration/);
  });
});

describe("a change", () => {
  it("is nothing until something is chosen", () => {
    expect(generateChange(ctx, defaultChangeOptions(ctx))).toMatchObject({ changes: [], script: "", undo: "" });
  });

  it("does not add a network that is already there", () => {
    expect(generateChange(ctx, opts((o) => (o.guest.add = true))).changes).toEqual([]);
  });

  const iot = generateChange(ctx, opts((o) => (o.iot.add = true)));

  it("adds an IoT network on its VLAN, tagged towards the access points", () => {
    expect(iot.changes).toEqual(['Add an IoT network: VLAN 30, 192.168.30.0/24, Wi-Fi "Maple-IoT"']);
    expect(iot.script).toContain('add name=vlan30-iot interface=bridge vlan-id=30 comment="Stribog IoT network"');
    expect(iot.script).toContain("add bridge=bridge vlan-ids=30 tagged=bridge,ether7,ether8");
    expect(iot.script).toContain("add name=dhcp-iot interface=vlan30-iot address-pool=pool-iot");
    expect(iot.script.indexOf("/export file=stribog-before-change")).toBeLessThan(iot.script.indexOf("/interface vlan"));
  });

  it("puts its firewall rules above the rules already there", () => {
    expect(iot.script).toContain(':local inTop [/ip firewall filter find where chain="input" && dynamic=no]');
    expect(iot.script).toMatch(/add chain=input action=drop in-interface=vlan30-iot .* place-before=\(\$inTop->0\)/);
    expect(iot.script).toMatch(/add chain=forward action=drop in-interface=vlan30-iot out-interface-list=!WAN connection-state=new .* place-before=\(\$fwTop->0\)/);
    // The LAN may reach it by default, so there is no rule against that.
    expect(iot.script).not.toContain("the LAN cannot reach it");
    // The masquerade already covers every source.
    expect(iot.script).not.toContain("/ip firewall nat");
  });

  it("adds its Wi-Fi on 2.4 GHz radios, disabled until a passphrase is set, and to provisioning", () => {
    expect(iot.script).toContain("add master-interface=cap-wifi1 configuration=cfg-iot name=cap-wifi1-iot disabled=yes");
    expect(iot.script).not.toContain("master-interface=cap-wifi2");
    expect(iot.script).toContain('set [find master-configuration="home-2g"] slave-configurations=guest-2g,cfg-iot');
    expect(iot.notes.some((n) => n.includes('passphrase="…"'))).toBe(true);
  });

  it("never carries a secret", () => {
    const all = generateChange(ctx, opts((o) => ((o.iot.add = true), (o.wifi.ssid = "Maple 2"), (o.wifi.security = "wpa3"))));
    expect(all.script).not.toMatch(/passphrase=|password=/);
    expect(all.undo).not.toMatch(/passphrase=|password=/);
  });

  it("comes with an undo that removes what it added and sets back what it changed", () => {
    expect(iot.undo).toContain('/interface vlan\nremove [find where comment="Stribog IoT network"]');
    expect(iot.undo).toContain('remove [find where comment~"^Stribog IoT network"]');
    expect(iot.undo).toContain('set [find master-configuration="home-2g"] slave-configurations=guest-2g');
  });

  it("changes the main Wi-Fi's name, security and 5 GHz channels, and undoes them", () => {
    const r = generateChange(ctx, opts((o) => ((o.wifi.ssid = "Maple Street"), (o.wifi.security = "wpa3"), (o.wifi.allowDfs = true), (o.wifi.width5 = "20/40/80/160mhz"))));
    expect(r.changes).toHaveLength(4);
    expect(r.script).toContain('set [find name="home-2g"] ssid="Maple Street"');
    expect(r.script).toContain('set [find name="sec-home"] authentication-types=wpa3-psk');
    expect(r.script).toContain('set [find name="ch-5g"] width=20/40/80/160mhz skip-dfs-channels=10min-cac');
    expect(r.undo).toContain('set [find name="home-5g"] ssid="Maple"');
    expect(r.undo).toContain('set [find name="sec-home"] authentication-types=wpa2-psk,wpa3-psk');
    expect(r.undo).toContain('set [find name="ch-5g"] width=20/40/80mhz skip-dfs-channels=all');
  });

  it("leaves out a network whose VLAN or subnet is taken", () => {
    const vlan = generateChange(ctx, opts((o) => ((o.iot.add = true), (o.iot.vlan = 20))));
    expect(vlan.changes).toEqual([]);
    expect(vlan.notes.join(" ")).toMatch(/VLAN 20 is already in use/);
    const subnet = generateChange(ctx, opts((o) => ((o.iot.add = true), (o.iot.subnet = "192.168.50.128/25"))));
    expect(subnet.changes).toEqual([]);
    expect(subnet.notes.join(" ")).toMatch(/overlaps 192.168.50.0\/24/);
  });

  it("does not turn VLAN filtering on when the bridge has it off, and says so", () => {
    const s = structuredClone(snap);
    s.devices.find((d) => d.role === "router")!.config.menus["/interface/bridge"]![0]!["vlan-filtering"] = "no";
    const c = ctxOf(s);
    const r = generateChange(c, opts((o) => (o.iot.add = true), c));
    expect(r.script).not.toContain("/interface bridge vlan");
    expect(r.script).not.toContain("vlan-filtering");
    expect(r.notes.join(" ")).toMatch(/VLAN filtering is off/);
  });

  it("is the same every time for the same choices", () => {
    const o = opts((x) => ((x.iot.add = true), (x.wifi.ssid = "Other")));
    expect(generateChange(ctx, o)).toEqual(generateChange(ctx, o));
  });
});
