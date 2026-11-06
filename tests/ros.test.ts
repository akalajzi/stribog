import { describe, expect, it } from "vitest";
import { enabled, isTrue, list, menu, parseExport, prop, scrub, single, tokenize, unquote } from "../src/core/ros.ts";

const HEADER = `# 2026-11-02 03:30:04 by RouterOS 7.20.4
# software id = DEMO-0001
#
# model = RB5009UPr+S+
# serial number = HFD0DEMO001
`;

describe("parseExport: header", () => {
  it("reads export time, version, model and software id", () => {
    const cfg = parseExport(HEADER + "/system identity\nset name=gw\n");
    expect(cfg.meta).toEqual({ exportedAt: "2026-11-02 03:30:04", version: "7.20.4", model: "RB5009UPr+S+", softwareId: "DEMO-0001" });
  });

  it("does not keep the serial number anywhere", () => {
    const cfg = parseExport(HEADER + "/system identity\nset name=gw\n");
    expect(JSON.stringify(cfg)).not.toContain("HFD0DEMO001");
  });

  it("does not treat header comments as notes on the first item", () => {
    const cfg = parseExport(HEADER + "/interface bridge\nadd name=bridge\n");
    expect(menu(cfg, "/interface/bridge")[0]!._notes).toBeUndefined();
  });
});

describe("parseExport: line continuations", () => {
  it("joins wrapped lines and drops the continuation indent", () => {
    const cfg = parseExport(`/interface bridge
add admin-mac=00:00:5E:00:53:01 auto-mac=no comment="Home LAN" name=bridge \\
    vlan-filtering=yes
`);
    expect(menu(cfg, "/interface/bridge")).toEqual([{ "admin-mac": "00:00:5E:00:53:01", "auto-mac": "no", comment: "Home LAN", name: "bridge", "vlan-filtering": "yes" }]);
  });

  it("joins a break right after = (the value is on the next line)", () => {
    const cfg = parseExport(`/ip dhcp-server lease
add address=192.168.50.2 comment="cAP living room" mac-address=\\
    00:00:5E:00:53:A0 server=home-dhcp
/interface ethernet
set [ find default-name=ether7 ] comment="Home LAN spare" poe-out=\\
    off
`);
    expect(menu(cfg, "/ip/dhcp-server/lease")[0]).toMatchObject({ "mac-address": "00:00:5E:00:53:A0", server: "home-dhcp" });
    expect(menu(cfg, "/interface/ethernet")[0]).toMatchObject({ "default-name": "ether7", "poe-out": "off" });
  });

  it("joins a break before a quoted value that continues on the next line", () => {
    const cfg = parseExport(`/interface bridge
add comment=\\
    "WAN and the temporary old network" name=bridge
`);
    expect(menu(cfg, "/interface/bridge")[0]).toEqual({ comment: "WAN and the temporary old network", name: "bridge" });
  });

  it("joins more than two physical lines", () => {
    const cfg = parseExport(`/ip firewall filter
add action=accept chain=input comment=\\
    "TEMP management" dst-port=22,80,8291 in-interface=bridge protocol=tcp \\
    src-address=\\
    192.168.1.0/24
`);
    expect(menu(cfg, "/ip/firewall/filter")[0]).toMatchObject({ comment: "TEMP management", protocol: "tcp", "src-address": "192.168.1.0/24" });
  });

  it("handles CRLF line endings", () => {
    const cfg = parseExport("/system identity\r\nset name=\\\r\n    gw\r\n");
    expect(single(cfg, "/system/identity")).toEqual({ name: "gw" });
  });
});

describe("parseExport: values", () => {
  it("keeps quoted values with spaces and escaped quotes", () => {
    const cfg = parseExport(`/interface wifi configuration
add name=guest ssid="Maple Guest" comment="say \\"hi\\" here"
`);
    expect(menu(cfg, "/interface/wifi/configuration")[0]).toMatchObject({ ssid: "Maple Guest", comment: 'say "hi" here' });
  });

  it("decodes \\XX UTF-8 byte escapes", () => {
    const cfg = parseExport(`/ip dhcp-server lease
add address=10.0.0.5 comment="Ku\\C4\\87a \\C4\\8Dista \\E2\\80\\93 test" mac-address=00:00:5E:00:53:05
`);
    expect(menu(cfg, "/ip/dhcp-server/lease")[0]!.comment).toBe("Kuća čista – test");
  });

  it("unquote leaves bare values alone and resolves simple escapes", () => {
    expect(unquote("ether1")).toBe("ether1");
    expect(unquote('"a\\\\b"')).toBe("a\\b");
    expect(unquote('"x\\ny"')).toBe("x\ny");
    expect(unquote('""')).toBe("");
  });

  it("tokenize keeps quoted strings and [ bracket ] expressions together", () => {
    expect(tokenize('set [ find default-name=ether1 ] comment="a b" poe-out=off')).toEqual(["set", "[ find default-name=ether1 ]", 'comment="a b"', "poe-out=off"]);
  });

  it("keeps = inside values", () => {
    const cfg = parseExport(`/system scheduler
add name=x on-event="/export file=nightly" interval=1d
`);
    expect(menu(cfg, "/system/scheduler")[0]).toMatchObject({ "on-event": "/export file=nightly", interval: "1d" });
  });
});

describe("parseExport: commands", () => {
  it("set [ find default-name=... ] creates the item named after its default name", () => {
    const cfg = parseExport(`/interface ethernet
set [ find default-name=ether1 ] comment="WAN to ONT" poe-out=off
set [ find default-name=ether2 ] name=nas comment=NAS
`);
    const eth = menu(cfg, "/interface/ethernet");
    expect(eth).toEqual([
      { "default-name": "ether1", name: "ether1", comment: "WAN to ONT", "poe-out": "off" },
      { "default-name": "ether2", name: "nas", comment: "NAS" },
    ]);
  });

  it("set [ find ... ] updates an existing matching item", () => {
    const cfg = parseExport(`/interface ethernet
set [ find default-name=ether1 ] comment=WAN
set [ find default-name=ether1 ] poe-out=off
`);
    expect(menu(cfg, "/interface/ethernet")).toEqual([{ "default-name": "ether1", name: "ether1", comment: "WAN", "poe-out": "off" }]);
  });

  it("set [ find default=yes ] targets the default item", () => {
    const cfg = parseExport(`/ipv6 nd
set [ find default=yes ] disabled=yes
`);
    expect(menu(cfg, "/ipv6/nd")).toEqual([{ default: "yes", disabled: "yes" }]);
  });

  it("set <name> addresses an item by name", () => {
    const cfg = parseExport(`/ip service
set ftp disabled=yes
set www address=192.168.50.0/24
set ftp port=2121
`);
    expect(menu(cfg, "/ip/service")).toEqual([
      { name: "ftp", disabled: "yes", port: "2121" },
      { name: "www", address: "192.168.50.0/24" },
    ]);
  });

  it("set without a target updates the singleton", () => {
    const cfg = parseExport(`/system ntp client
set enabled=yes
set mode=unicast
`);
    expect(menu(cfg, "/system/ntp/client")).toEqual([{ enabled: "yes", mode: "unicast" }]);
  });

  it("accepts a menu line with an inline command", () => {
    const cfg = parseExport(`/ip dns set allow-remote-requests=yes servers=1.1.1.1,9.9.9.9
/interface list member add interface=bridge list=LAN
`);
    expect(single(cfg, "/ip/dns")).toEqual({ "allow-remote-requests": "yes", servers: "1.1.1.1,9.9.9.9" });
    expect(menu(cfg, "/interface/list/member")).toEqual([{ interface: "bridge", list: "LAN" }]);
  });

  it("turns multi-word menus into slash paths", () => {
    const cfg = parseExport(`/interface wifi capsman
set enabled=yes interfaces=bridge
/tool mac-server mac-winbox
set allowed-interface-list=LAN
`);
    expect(Object.keys(cfg.menus)).toEqual(["/interface/wifi/capsman", "/tool/mac-server/mac-winbox"]);
  });

  it("ignores commands it does not model", () => {
    const cfg = parseExport(`/ip firewall filter
remove [ find comment~"TEMP" ]
add chain=input action=accept
`);
    expect(menu(cfg, "/ip/firewall/filter")).toEqual([{ chain: "input", action: "accept" }]);
  });
});

describe("parseExport: notes", () => {
  it("attaches comment lines to the next item only", () => {
    const cfg = parseExport(`/interface wifi
# operated by CAP 00:00:5E:00:53:A0%bridge, traffic processing on CAP
add configuration=home-2g name=cap-wifi1
add configuration=home-5g name=cap-wifi2
# managed by CAPsMAN 00:00:5E:00:53:01%bridgeLocal, traffic processing on CAP
# mode: AP, SSID: Maple, channel: 5180/ax/Ceee
set [ find default-name=wifi2 ] disabled=no
`);
    const w = menu(cfg, "/interface/wifi");
    expect(w[0]!._notes).toBe("operated by CAP 00:00:5E:00:53:A0%bridge, traffic processing on CAP");
    expect(w[1]!._notes).toBeUndefined();
    expect(w[2]!._notes).toBe("managed by CAPsMAN 00:00:5E:00:53:01%bridgeLocal, traffic processing on CAP\nmode: AP, SSID: Maple, channel: 5180/ax/Ceee");
  });

  it("does not carry notes across a menu change", () => {
    const cfg = parseExport(`/interface wifi
# dangling note
/interface bridge
add name=bridge
`);
    expect(menu(cfg, "/interface/bridge")[0]!._notes).toBeUndefined();
  });
});

describe("secret scrubbing", () => {
  it("hides passphrases, passwords and keys from exports", () => {
    const cfg = parseExport(`/interface wifi security
add authentication-types=wpa2-psk name=sec passphrase="correct horse \\"battery\\""
/ppp secret
add name=vpn password=hunter2
/interface wireguard
add name=wg0 private-key="aGVsbG8="
/interface pppoe-client
add name=pppoe-out1 user=me password=s3cret
`);
    expect(menu(cfg, "/interface/wifi/security")[0]!.passphrase).toBe("<hidden>");
    expect(menu(cfg, "/ppp/secret")[0]!.password).toBe("<hidden>");
    expect(menu(cfg, "/interface/wireguard")[0]!["private-key"]).toBe("<hidden>");
    expect(menu(cfg, "/interface/pppoe-client")[0]).toMatchObject({ user: "me", password: "<hidden>" });
    const text = JSON.stringify(cfg);
    for (const secret of ["correct horse", "hunter2", "aGVsbG8=", "s3cret"]) expect(text).not.toContain(secret);
  });

  it("scrub() hides dotted and prefixed keys too", () => {
    expect(scrub({ "security.passphrase": "x", "ipsec-secret": "y", name: "n" } as never)).toEqual({ "security.passphrase": "<hidden>", "ipsec-secret": "<hidden>", name: "n" });
  });

  // BUG (src/core/ros.ts SENSITIVE): the pattern is anchored at the end of the key, so keys that
  // end in "-key" slip through: WireGuard peers' `preshared-key`, legacy wireless
  // `wpa-pre-shared-key` / `wpa2-pre-shared-key`, and e.g. OSPF/VRRP `auth-key`.
  it("scrub() hides *-key secrets (preshared-key, wpa2-pre-shared-key, auth-key)", () => {
    const rec = scrub({ "preshared-key": "a", "wpa2-pre-shared-key": "b", "wpa-pre-shared-key": "c", "auth-key": "d" } as never);
    expect(Object.values(rec).every((v) => v === "<hidden>")).toBe(true);
  });
});

describe("helpers", () => {
  it("prop falls back for missing or empty values", () => {
    expect(prop({ a: "" }, "a", "d")).toBe("d");
    expect(prop(undefined, "a", "d")).toBe("d");
    expect(prop({ a: "x" }, "a", "d")).toBe("x");
  });

  it("isTrue, enabled and list", () => {
    expect(isTrue("yes")).toBe(true);
    expect(isTrue("true")).toBe(true);
    expect(isTrue("no")).toBe(false);
    expect(enabled({ disabled: "yes" })).toBe(false);
    expect(enabled({})).toBe(true);
    expect(enabled(undefined)).toBe(false);
    expect(list(" a, b,,c ")).toEqual(["a", "b", "c"]);
    expect(list(undefined)).toEqual([]);
  });
});
