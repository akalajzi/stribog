import { describe, expect, it } from "vitest";
import { describePorts, describeRule, summarizeFirewall } from "../src/core/firewall.ts";
import type { FwRule } from "../src/core/model.ts";

const r = (x: Partial<FwRule> & { chain: string; action: string }): FwRule => x;

// The RouterOS default configuration, in router order.
const defconfFilter: FwRule[] = [
  r({ chain: "input", action: "accept", "connection-state": "established,related,untracked", comment: "defconf: accept established,related,untracked" }),
  r({ chain: "input", action: "drop", "connection-state": "invalid", comment: "defconf: drop invalid" }),
  r({ chain: "input", action: "accept", protocol: "icmp", comment: "defconf: accept ICMP" }),
  r({ chain: "input", action: "accept", "dst-address": "127.0.0.1", "src-address": "127.0.0.1", "in-interface": "lo", comment: "defconf: accept to local loopback (for CAPsMAN)" }),
  r({ chain: "input", action: "drop", "in-interface-list": "!LAN", comment: "defconf: drop all not coming from LAN" }),
  r({ chain: "forward", action: "accept", "ipsec-policy": "in,ipsec", comment: "defconf: accept in ipsec policy" }),
  r({ chain: "forward", action: "fasttrack-connection", "connection-state": "established,related", comment: "defconf: fasttrack" }),
  r({ chain: "forward", action: "accept", "connection-state": "established,related,untracked", comment: "defconf: accept established,related, untracked" }),
  r({ chain: "forward", action: "drop", "connection-state": "invalid", comment: "defconf: drop invalid" }),
  r({ chain: "forward", action: "drop", "connection-nat-state": "!dstnat", "in-interface-list": "WAN", comment: "defconf: drop all from WAN not DSTNATed" }),
];
const defconfNat: FwRule[] = [r({ chain: "srcnat", action: "masquerade", "out-interface-list": "WAN", "ipsec-policy": "out,none", comment: "defconf: masquerade" })];

describe("describeRule", () => {
  it("words the default rules for people", () => {
    const t = defconfFilter.map((x) => describeRule(x).text);
    expect(t[0]).toBe("Allow replies to connections the router started");
    expect(t[1]).toBe("Drop broken or out-of-sequence packets to the router");
    expect(t[2]).toMatch(/^Allow ICMP \(ping/);
    expect(t[3]).toBe("Allow the router to talk to itself");
    expect(t[4]).toBe("Drop everything to the router that does not come from the LAN");
    expect(t[5]).toMatch(/IPsec/);
    expect(t[6]).toBe("Fast-track established connections");
    expect(t[7]).toBe("Let replies to existing connections through");
    expect(t[8]).toBe("Drop broken or out-of-sequence packets");
    expect(t[9]).toBe("Drop new connections from the internet unless they are port-forwarded");
    expect(describeRule(defconfNat[0]!).text).toBe("Share the router's internet address with every device (masquerade)");
  });

  it("names management ports and the source", () => {
    const d = describeRule(r({ chain: "input", action: "accept", protocol: "tcp", "dst-port": "22,80,8291", "src-address": "192.168.50.0/24", "in-interface": "bridge-up" }), { "bridge-up": "Upstream" });
    expect(d.text).toBe("Allow SSH, WebFig (HTTP) and WinBox to the router from 192.168.50.0/24 on Upstream (bridge-up)");
    expect(d.verdict).toBe("allow");
  });

  it("explains port forwards and generic drops", () => {
    expect(describeRule(r({ chain: "dstnat", action: "dst-nat", protocol: "tcp", "dst-port": "443", "in-interface-list": "WAN", "to-addresses": "10.0.0.5" })).text).toBe("Forward HTTPS from the internet to 10.0.0.5");
    expect(describeRule(r({ chain: "dstnat", action: "dst-nat", protocol: "udp", "dst-port": "27015", "in-interface-list": "WAN", "to-addresses": "10.0.0.6" })).text).toBe("Forward UDP port 27015 from the internet to 10.0.0.6");
    expect(describeRule(r({ chain: "forward", action: "drop", "in-interface": "vlan20", "out-interface-list": "!WAN" })).text).toBe("Drop everything on vlan20 that is not going to the internet side (WAN)");
    expect(describeRule(r({ chain: "srcnat", action: "src-nat", "src-address": "10.0.0.0/24", "dst-address": "10.0.0.7", "to-addresses": "10.0.0.1" })).note).toMatch(/hairpin/);
  });

  it("describes port lists", () => {
    expect(describePorts("53", "udp")).toBe("DNS");
    expect(describePorts("8000-8100", "tcp")).toBe("TCP ports 8000-8100");
    expect(describePorts("22,2222", "tcp")).toBe("SSH and TCP port 2222");
  });
});

describe("summarizeFirewall", () => {
  it("groups rules, keeps order and flags defaults, temporary and disabled rules", () => {
    const filter = [...defconfFilter];
    filter.splice(4, 0, r({ chain: "input", action: "accept", protocol: "tcp", "dst-port": "8291", "src-address": "192.168.50.2", comment: "TEMP setup access", disabled: true }));
    const g = summarizeFirewall({ filter, nat: defconfNat });
    expect(g.input).toHaveLength(6);
    expect(g.forward).toHaveLength(5);
    expect(g.nat).toHaveLength(1);
    expect(g.input.every((s) => s.group === "input")).toBe(true);
    expect(g.input.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
    const temp = g.input[4]!;
    expect(temp.temporary).toBe(true);
    expect(temp.disabled).toBe(true);
    expect(temp.isDefault).toBe(false);
    expect(temp.text).toBe("Allow WinBox to the router from 192.168.50.2 (temporary)");
    expect(g.input[0]!.isDefault).toBe(true);
    expect(summarizeFirewall(undefined).input).toEqual([]);
  });
});
