import { describe, expect, it } from "vitest";
import { defaultSetupOptions, generateSetup, rosQuote, type SetupOptions } from "../src/core/setup.ts";

const code = (script: string) => script.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
const opts = (patch: (o: SetupOptions) => void = () => {}, preset: "home" | "office" = "home") => {
  const o = defaultSetupOptions(preset, ["ether1", "ether2", "ether3", "ether4", "ether5"]);
  patch(o);
  return o;
};
const indexOf = (lines: string[], re: RegExp) => lines.findIndex((l) => re.test(l));

describe("generateSetup", () => {
  it("starts with the reset warning and builds the LAN", () => {
    const { script } = generateSetup(opts());
    expect(script.split("\n")[1]).toBe("# For a router reset with no default configuration; review every line.");
    expect(script).toContain("add name=bridge comment=\"LAN\" vlan-filtering=no");
    expect(script).toContain("add address=192.168.88.1/24 interface=bridge");
    expect(script).toContain("add name=pool-lan ranges=192.168.88.100-192.168.88.229");
    expect(script).toContain("add name=dhcp-lan interface=bridge address-pool=pool-lan lease-time=1d");
    expect(script).toContain("add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=192.168.88.1");
    expect(script).toContain("add list=LAN interface=bridge");
    expect(script).toContain("add list=WAN interface=ether1");
    // WAN port is not bridged; every other port is.
    expect(script).not.toContain("interface=ether1\n/interface bridge port");
    expect(script).not.toMatch(/add bridge=bridge interface=ether1\b/);
    expect(script).toMatch(/add bridge=bridge interface=ether5/);
    // VLAN filtering is switched on last.
    expect(code(script).at(-1)).toBe("/interface bridge set bridge vlan-filtering=yes");
  });

  it("uses the DHCP client or PPPoE for the WAN, never with a password", () => {
    const dhcp = generateSetup(opts()).script;
    expect(dhcp).toContain("/ip dhcp-client\nadd interface=ether1");
    expect(dhcp).not.toContain("pppoe-client");

    const r = generateSetup(opts((o) => (o.wan = { port: "ether2", type: "pppoe", pppoeUser: "someone@isp.example" })));
    expect(r.script).toContain('add name=pppoe-out1 interface=ether2 user="someone@isp.example"');
    expect(r.script).toContain("add list=WAN interface=pppoe-out1");
    expect(r.script).not.toMatch(/add bridge=bridge interface=ether2\b/);
    expect(r.notes.some((n) => /PPPoE password/.test(n))).toBe(true);
  });

  it("never puts a password or passphrase in executable lines", () => {
    const r = generateSetup(opts((o) => { o.guest.enabled = true; o.iot.enabled = true; o.wan = { port: "ether1", type: "pppoe", pppoeUser: "u" }; }));
    for (const l of code(r.script)) {
      expect(l).not.toMatch(/password=/);
      expect(l).not.toMatch(/passphrase=/);
    }
  });

  it("chooses DNS: router cache or a LAN server with the router as fallback", () => {
    const router = generateSetup(opts((o) => (o.dns = { mode: "router", upstreams: ["9.9.9.9", "149.112.112.112"] }))).script;
    expect(router).toContain("/ip dns set servers=9.9.9.9,149.112.112.112 allow-remote-requests=yes");
    const lanSrv = generateSetup(opts((o) => (o.dns = { mode: "lan-server", upstreams: ["1.1.1.1"], lanServer: "192.168.88.10" })));
    expect(lanSrv.script).toContain("dns-server=192.168.88.10,192.168.88.1");
    expect(lanSrv.notes.some((n) => /fallback/.test(n))).toBe(true);
  });

  it("sets up CAPsMAN Wi-Fi with the 1/6/11 plan and the chosen 5 GHz options", () => {
    const s = generateSetup(opts((o) => { o.wifi.ssid = "Test Net"; o.wifi.width5 = "20/40mhz"; o.wifi.allowDfs = true; o.wifi.country = "Germany"; })).script;
    expect(s).toContain("add name=ch-2g band=2ghz-ax width=20mhz frequency=2412,2437,2462");
    expect(s).toContain("add name=ch-5g band=5ghz-ax width=20/40mhz skip-dfs-channels=10min-cac");
    expect(s).toContain('ssid="Test Net" country="Germany"');
    expect(s).toContain("authentication-types=wpa2-psk,wpa3-psk ft=yes");
    expect(s).toContain("/interface wifi capsman\nset enabled=yes interfaces=bridge");
    expect(s).toMatch(/provisioning\nadd action=create-dynamic-enabled supported-bands=2ghz-ax master-configuration=cfg-main-2g/);
    const noDfs = generateSetup(opts((o) => { o.wifi.allowDfs = false; o.wifi.security = "wpa3"; })).script;
    expect(noDfs).toContain("skip-dfs-channels=all");
    expect(noDfs).toContain("add name=sec-main authentication-types=wpa3-psk");
    const off = generateSetup(opts((o) => (o.wifi.enabled = false))).script;
    expect(off).not.toContain("/interface wifi");
  });

  it("adds guest and IoT isolation only when enabled", () => {
    const plain = generateSetup(opts()).script;
    expect(plain).not.toContain("/interface vlan");
    expect(plain).not.toContain("LIMITED");
    expect(plain).not.toContain("guest:");
    expect(plain).not.toContain("dp-guest");

    const guest = generateSetup(opts((o) => { o.guest.enabled = true; o.guest.isolation = true; })).script;
    expect(guest).toContain("add name=vlan20-guest interface=bridge vlan-id=20");
    expect(guest).toContain("add bridge=bridge vlan-ids=20 tagged=bridge,ether2,ether3,ether4,ether5");
    expect(guest).toContain("in-interface=vlan20-guest out-interface-list=!WAN");
    expect(guest).toContain("add name=dp-guest bridge=bridge vlan-id=20 client-isolation=yes");
    expect(guest).not.toContain("vlan30");

    const iot = generateSetup(opts((o) => { o.iot.enabled = true; o.iot.lanCanReach = false; o.apPorts = ["ether4"]; })).script;
    expect(iot).toContain("add bridge=bridge vlan-ids=30 tagged=bridge,ether4 ");
    expect(iot).toContain("in-interface=vlan30-iot out-interface-list=!WAN");
    expect(iot).toContain("out-interface=vlan30-iot in-interface-list=LAN");
    expect(iot).toContain("add name=sec-iot authentication-types=wpa2-psk\n");
    expect(iot).not.toContain("vlan20");
    const reachable = generateSetup(opts((o) => { o.iot.enabled = true; o.iot.lanCanReach = true; })).script;
    expect(reachable).not.toContain("out-interface=vlan30-iot in-interface-list=LAN");
  });

  it("keeps the firewall in a sane order", () => {
    const lines = code(generateSetup(opts((o) => { o.guest.enabled = true; o.iot.enabled = true; })).script);
    const i = (re: RegExp) => {
      const n = indexOf(lines, re);
      expect(n, String(re)).toBeGreaterThanOrEqual(0);
      return n;
    };
    const inEst = i(/chain=input action=accept connection-state=established/);
    const inInvalid = i(/chain=input action=drop connection-state=invalid/);
    const inLan = i(/chain=input action=accept in-interface-list=LAN/);
    const inLimited = i(/chain=input action=accept in-interface-list=LIMITED/);
    const inDrop = i(/chain=input action=drop comment="drop everything else"/);
    expect(inEst).toBeLessThan(inInvalid);
    expect(inInvalid).toBeLessThan(inLan);
    expect(inLimited).toBeLessThan(inDrop);
    expect(inLan).toBeLessThan(inDrop);
    const fast = i(/action=fasttrack-connection/);
    const fwEst = i(/chain=forward action=accept connection-state=established/);
    const fwWan = i(/chain=forward action=drop connection-nat-state=!dstnat in-interface-list=WAN/);
    const guestDrop = i(/in-interface=vlan20-guest/);
    expect(fast).toBeLessThan(fwEst);
    expect(fwEst).toBeLessThan(fwWan);
    expect(fwEst).toBeLessThan(guestDrop);
    // The final input drop is the last input rule.
    expect(lines.slice(inDrop + 1).some((l) => /chain=input/.test(l))).toBe(false);
    expect(i(/chain=srcnat action=masquerade out-interface-list=WAN/)).toBeGreaterThan(0);
  });

  it("locks down management and schedules backups", () => {
    const s = generateSetup(opts((o) => (o.adminSubnet = "192.168.88.0/28"))).script;
    for (const svc of ["telnet", "ftp", "api", "api-ssl"]) expect(s).toContain(`set ${svc} disabled=yes`);
    for (const svc of ["www", "ssh", "winbox"]) expect(s).toContain(`set ${svc} address=192.168.88.0/28`);
    expect(s).toContain("/system ntp client set enabled=yes");
    expect(s).toContain('/system identity set name="home-gw"');
    expect(s).toContain("add name=nightly-export interval=1d");
    expect(generateSetup(opts((o) => (o.nightlyExport = false))).script).not.toContain("scheduler");
  });

  it("office preset brings guest and a devices network", () => {
    const r = generateSetup(defaultSetupOptions("office"));
    expect(r.script).toContain("small-office");
    expect(r.script).toContain("vlan20-guest");
    expect(r.script).toContain("vlan30-devices");
    expect(r.script).toContain('ssid="Office-Devices"');
  });

  it("falls back on bad input and says so", () => {
    const r = generateSetup(opts((o) => { o.lan.subnet = "nonsense"; o.lan.pool = "1.2.3.4-1.2.3.9"; }));
    expect(r.script).toContain("add address=192.168.88.1/24 interface=bridge");
    expect(r.notes.some((n) => /not a usable LAN subnet/.test(n))).toBe(true);
    const p = generateSetup(opts((o) => (o.lan.pool = "10.0.0.5-10.0.0.9")));
    expect(p.notes.some((n) => /pool/.test(n))).toBe(true);
  });

  it("quotes RouterOS strings safely", () => {
    expect(rosQuote('My "Net" $HOME?')).toBe('"My \\"Net\\" \\$HOME\\?"');
    const s = generateSetup(opts((o) => (o.wifi.ssid = "Cafe $5?"))).script;
    expect(s).toContain('ssid="Cafe \\$5\\?"');
  });
});
