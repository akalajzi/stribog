import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyze, type Analysis, type Finding, type Severity } from "../src/core/analyze.ts";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { buildModel } from "../src/core/model.ts";
import { parseExport, type RosRecord, type Snapshot } from "../src/core/ros.ts";

const DEMO = resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json");

function run(snap: Snapshot): Analysis {
  return analyze(buildModel(snap), snap);
}

function demo(): Analysis {
  const { config, base } = readConfig(DEMO);
  return run(snapshotFromFiles(config, base));
}

const find = (a: Analysis, id: string) => a.findings.find((f) => f.id === id);
const ids = (a: Analysis) => a.findings.map((f) => f.id);

/** One router from an inline export plus optional runtime state. */
const snapOf = (rsc: string, state?: Record<string, RosRecord[]>): Snapshot => ({
  collectedAt: "2026-01-01",
  devices: [{ role: "router", config: parseExport(rsc), state, sources: [] }],
});

/** A minimal, tidy home LAN to hang single problems on. */
const BASE = `/interface bridge
add name=bridge
/interface list
add name=WAN
add name=LAN
/interface list member
add interface=bridge list=LAN
add interface=ether1 list=WAN
/ip pool
add name=pool ranges=10.0.0.100-10.0.0.199
/ip dhcp-server
add address-pool=pool interface=bridge name=dhcp1
/ip address
add address=10.0.0.1/24 interface=bridge network=10.0.0.0
/ip dhcp-client
add interface=ether1
`;

describe("analyze: demo network", () => {
  const a = demo();

  it("fires the expected problems with the expected severities", () => {
    const expected: Record<string, Severity> = {
      "dhcp-private-mac-reservations": "warning",
      "wifi-5-one-block": "warning",
      "cap-versions-differ": "warning",
      "svc-insecure": "warning",
      "fw-temporary-rules": "suggestion",
      "wifi-24-capable-00:00:5E:00:53:76": "suggestion",
      "wifi-weak-F2:00:5E:00:53:77": "suggestion",
      "wifi-wpa2-only-Maple Guest": "suggestion",
      "svc-unrestricted": "suggestion",
      "seg-flat-network": "suggestion",
      "update-channels-differ": "suggestion",
      "planned-poe-garden-ap": "suggestion",
      "port-slow-ether4": "suggestion",
      "wifi-24-expected-00:00:5E:00:53:40": "info",
      "wifi-24-expected-00:00:5E:00:53:41": "info",
      "wifi-24-expected-00:00:5E:00:53:50": "info",
      "dhcp-unused-reservations": "info",
    };
    for (const [id, sev] of Object.entries(expected)) expect(find(a, id)?.severity, id).toBe(sev);
  });

  it("reports what is already good", () => {
    const passes = a.findings.filter((f) => f.severity === "pass").map((f) => f.id);
    for (const id of [
      "wan-public",
      "dns-redundant",
      "wifi-5-non-dfs",
      "wifi-wpa3-available",
      "wifi-ft-on",
      "backup-scheduled",
      "dhcp-reservations-outside-pool",
      "dhcp-pool-ok",
      "wifi-24-plan",
      "wifi-country",
      "capsman-scope",
      "fw-defaults",
      "lan-only-discovery",
      "ntp-on",
      "hw-offload",
    ])
      expect(passes, id).toContain(id);
  });

  it("does not raise problems the demo has deliberately avoided", () => {
    for (const id of ["wan-double-nat", "wan-devices-outside", "dns-single-host", "dns-router-depends", "router-identity", "backup-none", "ntp-off", "seg-no-guest", "wifi-ft-off", "fw-empty", "fw-gaps", "capsman-scope-wide", "dhcp-pool-full", "usb-auto-sharing", "ssh-forwarding"])
      expect(ids(a), id).not.toContain(id);
    expect(ids(a).filter((id) => id.startsWith("rule-error"))).toEqual([]);
  });

  it("explains the rotated private MAC with the online twin", () => {
    const f = find(a, "dhcp-private-mac-reservations")!;
    expect(f.devices).toEqual(["mac:3A:00:5E:00:53:60"]);
    expect(f.evidence).toContain("Emma-iPhone is online as D6:00:5E:00:53:75 on 192.168.50.105 (from the pool), not on its reserved 192.168.50.60");
  });

  it("names the AP that lags behind the controller", () => {
    const f = find(a, "cap-versions-differ")!;
    expect(f.summary).toContain("Upstairs AP runs 7.19.6");
    expect(f.devices).toEqual(["mac:00:00:5E:00:53:B0"]);
  });

  it("only flags SSH as unrestricted (www and winbox are limited to the LAN)", () => {
    expect(find(a, "svc-unrestricted")!.evidence).toEqual(["/ip service ssh: enabled, address=(any)"]);
    expect(find(a, "svc-insecure")!.fix?.cli).toBe("/ip service disable telnet");
  });

  it("sorts by severity, counts consistently and scores", () => {
    const order: Severity[] = ["critical", "warning", "suggestion", "info", "pass"];
    const ranks = a.findings.map((f) => order.indexOf(f.severity));
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
    for (const s of order) expect(a.counts[s]).toBe(a.findings.filter((f) => f.severity === s).length);
    // 4 warnings × 5 + suggestions × 1.5 (capped at 20)
    const expectedScore = Math.round(100 - a.counts.warning * 5 - a.counts.critical * 20 - Math.min(20, a.counts.suggestion * 1.5));
    expect(a.score).toBe(expectedScore);
    expect(a.score).toBeGreaterThanOrEqual(60);
    expect(a.score).toBeLessThan(85);
    expect(a.grade).toBe(a.score >= 85 ? "great" : a.score >= 65 ? "good" : "fair");
  });

  it("gives every finding a unique id, a title and a summary", () => {
    expect(new Set(ids(a)).size).toBe(a.findings.length);
    for (const f of a.findings) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.summary.length).toBeGreaterThan(0);
    }
  });

  // BUG (src/core/model.ts ssidFor, see tests/model.test.ts): the guest SSID is attributed to the
  // home LAN, so this suggestion fires although "Maple Guest" is on its own VLAN.
  it("does not count a guest SSID on its own VLAN as a duplicate", () => {
    expect(ids(a)).not.toContain("wifi-duplicate-ssids-bridge");
  });
});

describe("analyze: targeted configs", () => {
  it("dns-single-host: one DNS server that is a LAN host", () => {
    const a = run(
      snapOf(
        BASE +
          `/ip dhcp-server network
add address=10.0.0.0/24 dns-server=10.0.0.5 gateway=10.0.0.1
/ip dhcp-server lease
add address=10.0.0.5 comment="Pi-hole box" mac-address=00:00:5E:00:53:05 server=dhcp1
`,
      ),
    );
    const f = find(a, "dns-single-host")!;
    expect(f.severity).toBe("warning");
    expect(f.title).toBe("All name lookups depend on Pi-hole box");
    expect(f.devices).toEqual(["mac:00:00:5E:00:53:05"]);
    expect(f.fix?.cli).toContain("dns-server=10.0.0.5,10.0.0.1");
  });

  it("dns-single-router passes and dns-none warns", () => {
    expect(find(run(snapOf(BASE + `/ip dhcp-server network\nadd address=10.0.0.0/24 dns-server=10.0.0.1 gateway=10.0.0.1\n`)), "dns-single-router")?.severity).toBe("pass");
    expect(find(run(snapOf(BASE + `/ip dhcp-server network\nadd address=10.0.0.0/24 gateway=10.0.0.1\n`)), "dns-none")?.severity).toBe("warning");
  });

  it("dns-router-depends: the router's own resolver is a single LAN host", () => {
    const a = run(
      snapOf(
        BASE +
          `/ip dhcp-server lease
add address=10.0.0.5 comment="DNS box" mac-address=00:00:5E:00:53:05 server=dhcp1
/ip dns
set servers=10.0.0.5
/system ntp client servers
add address=pool.ntp.org
`,
      ),
    );
    expect(find(a, "dns-router-depends")).toMatchObject({ severity: "warning" });
    expect(find(a, "dns-router-depends")!.summary).toContain("pool.ntp.org");
  });

  it("fw-temporary-rules: an active temporary rule that opens management is a warning", () => {
    const a = run(
      snapOf(
        BASE +
          `/ip firewall filter
add action=accept chain=input comment="TEMP management from old LAN" dst-port=22,8291 in-interface=ether1 protocol=tcp src-address=192.168.1.0/24
add action=drop chain=input in-interface-list=!LAN
`,
      ),
    );
    const f = find(a, "fw-temporary-rules")!;
    expect(f.severity).toBe("warning");
    expect(f.summary).toContain("22,8291");
    expect(f.evidence![0]).toMatch(/^active: input accept 192\.168\.1\.0\/24 tcp 22,8291/);
  });

  it("fw-temporary-rules: disabled leftovers are only a suggestion", () => {
    const a = run(snapOf(BASE + `/ip firewall filter\nadd action=accept chain=input comment="temporary test" disabled=yes dst-port=80 protocol=tcp\n`));
    expect(find(a, "fw-temporary-rules")?.severity).toBe("suggestion");
  });

  it("dhcp-private-mac-reservations: suggestion from config only, warning when the device is gone", () => {
    const rsc = BASE + `/ip dhcp-server lease\nadd address=10.0.0.20 comment="Kim phone" mac-address=DA:00:5E:00:53:20 server=dhcp1\n`;
    expect(find(run(snapOf(rsc)), "dhcp-private-mac-reservations")?.severity).toBe("suggestion");
    const live = run(
      snapOf(rsc, {
        "/ip/dhcp-server/lease": [
          { address: "10.0.0.20", "mac-address": "DA:00:5E:00:53:20", server: "dhcp1", status: "waiting", comment: "Kim phone" },
          { address: "10.0.0.150", "mac-address": "AE:00:5E:00:53:21", server: "dhcp1", status: "bound", "host-name": "Kim-phone" },
        ],
      }),
    );
    const f = find(live, "dhcp-private-mac-reservations")!;
    expect(f.severity).toBe("warning");
    expect(f.evidence).toContain("Kim-phone is online as AE:00:5E:00:53:21 on 10.0.0.150 (from the pool), not on its reserved 10.0.0.20");
  });

  it("a bare router: no firewall is critical, and the basics are suggested", () => {
    const a = run(snapOf(BASE));
    expect(find(a, "fw-empty")?.severity).toBe("critical");
    for (const id of ["router-identity", "backup-none", "ntp-off", "seg-no-guest", "svc-insecure"]) expect(ids(a), id).toContain(id);
    expect(a.score).toBeLessThan(80);
  });

  it("wan-double-nat: a private WAN lease is a warning, CGNAT is named", () => {
    const priv = run(snapOf(BASE, { "/ip/dhcp-client": [{ interface: "ether1", address: "192.168.1.20/24", gateway: "192.168.1.1" }] }));
    expect(find(priv, "wan-double-nat")).toMatchObject({ severity: "warning", title: "Double NAT behind ISP router" });
    const cg = run(snapOf(BASE, { "/ip/dhcp-client": [{ interface: "ether1", address: "100.70.1.2/10", gateway: "100.64.0.1" }] }));
    expect(find(cg, "wan-double-nat")!.title).toBe("Behind carrier-grade NAT");
  });

  it("reservations inside the pool are a suggestion", () => {
    const a = run(snapOf(BASE + `/ip dhcp-server lease\nadd address=10.0.0.150 comment="Desk PC" mac-address=00:00:5E:00:53:30 server=dhcp1\n`));
    expect(find(a, "dhcp-reservations-in-pool")?.severity).toBe("suggestion");
  });

  it("fast roaming off with two APs is a warning", () => {
    const a = run(
      snapOf(
        BASE +
          `/interface wifi security
add authentication-types=wpa2-psk,wpa3-psk ft=no name=sec
/interface wifi configuration
add country=Germany name=c5 security=sec ssid=Home
/interface wifi
# operated by CAP 00:00:5E:00:53:A0%bridge, traffic processing on CAP
add configuration=c5 name=cap-wifi1
# operated by CAP 00:00:5E:00:53:B0%bridge, traffic processing on CAP
add configuration=c5 name=cap-wifi2
`,
      ),
    );
    expect(find(a, "wifi-ft-off")?.severity).toBe("warning");
  });

  it("never throws on an empty snapshot", () => {
    const a = run({ collectedAt: "x", devices: [] });
    expect(a.findings.filter((f: Finding) => f.id.startsWith("rule-error"))).toEqual([]);
    expect(a.score).toBeGreaterThanOrEqual(0);
  });
});
