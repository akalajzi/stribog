// A clean, opinionated MikroTik setup, as a script to review.
//
// generateSetup() turns a handful of choices into a RouterOS v7 script for a router reset with no
// default configuration: one bridge with VLAN filtering, a trusted LAN, optional guest and IoT
// networks, the defconf-style firewall plus isolation between networks, CAPsMAN Wi-Fi, locked-down
// management and nightly exports. Pure and deterministic: same options, same script. Secrets are
// never part of the output; the script leaves them unset so nothing comes up with a guessable key.

import { intToIp, ipToInt, parseCidr } from "./net.ts";

export type SetupPreset = "home" | "office";

export interface SideNetwork {
  enabled: boolean;
  vlan: number;
  /** Subnet in CIDR form; the router takes the first address. */
  subnet: string;
  ssid: string;
}

export interface SetupOptions {
  preset: SetupPreset;
  identity: string;
  /** Every Ethernet/SFP port on the router, in panel order. */
  ports: string[];
  /** Ports with access points behind them: they carry the tagged guest/IoT VLANs. Empty means every LAN port. */
  apPorts: string[];
  wan: { port: string; type: "dhcp" | "pppoe"; pppoeUser?: string };
  lan: { subnet: string; pool: string; leaseTime: string };
  dns: { mode: "router" | "lan-server"; upstreams: string[]; lanServer?: string };
  wifi: {
    enabled: boolean;
    ssid: string;
    security: "wpa2-wpa3" | "wpa3";
    country: string;
    /** Radio generation of the access points: ax (Wi-Fi 6) or ac (Wi-Fi 5). */
    gen: "ax" | "ac";
    width5: "20mhz" | "20/40mhz" | "20/40/80mhz" | "20/40/80/160mhz";
    allowDfs: boolean;
  };
  guest: SideNetwork & { isolation: boolean };
  /** IoT network at home; the "devices" network (printers, cameras, door access) in an office. */
  iot: SideNetwork & { lanCanReach: boolean };
  /** Management (WebFig, SSH, WinBox) is accepted only from here. Defaults to the LAN subnet. */
  adminSubnet?: string;
  ntp: string[];
  timezone: string;
  nightlyExport: boolean;
}

export interface SetupResult {
  script: string;
  notes: string[];
}

/** Sensible starting points. `ports` lets the UI pass the real router's ports. */
export function defaultSetupOptions(preset: SetupPreset = "home", ports?: string[]): SetupOptions {
  const office = preset === "office";
  const p = ports?.length ? ports : ["ether1", "ether2", "ether3", "ether4", "ether5", "ether6", "ether7", "ether8", "sfp-sfpplus1"];
  return {
    preset,
    identity: office ? "office-gw" : "home-gw",
    ports: p,
    apPorts: [],
    wan: { port: p[0] ?? "ether1", type: "dhcp" },
    lan: office
      ? { subnet: "10.20.0.0/24", pool: "10.20.0.100-10.20.0.229", leaseTime: "8h" }
      : { subnet: "192.168.88.0/24", pool: "192.168.88.100-192.168.88.229", leaseTime: "1d" },
    dns: { mode: "router", upstreams: ["1.1.1.1", "9.9.9.9"] },
    wifi: { enabled: true, ssid: office ? "Office" : "Home", security: "wpa2-wpa3", country: "", gen: "ax", width5: "20/40/80mhz", allowDfs: false },
    guest: office
      ? { enabled: true, vlan: 20, subnet: "10.20.20.0/24", ssid: "Office-Guest", isolation: true }
      : { enabled: false, vlan: 20, subnet: "192.168.20.0/24", ssid: "Home-Guest", isolation: true },
    iot: office
      ? { enabled: true, vlan: 30, subnet: "10.20.30.0/24", ssid: "Office-Devices", lanCanReach: true }
      : { enabled: false, vlan: 30, subnet: "192.168.30.0/24", ssid: "Home-IoT", lanCanReach: true },
    ntp: ["pool.ntp.org"],
    timezone: "",
    nightlyExport: true,
  };
}

// ---------------------------------------------------------------------------

/** Quote a RouterOS string: escape \ " $ and ? (the terminal treats the last two specially). */
export function rosQuote(v: string): string {
  return `"${v.replace(/[\\"$?]/g, (c) => `\\${c}`)}"`;
}

const IDENT = /[^A-Za-z0-9_.-]/g;
const ident = (v: string, fallback: string) => v.replace(IDENT, "-").replace(/^-+|-+$/g, "") || fallback;

interface Net {
  cidr: string;
  gw: string;
  prefix: number;
  first: number;
  last: number;
}

function net(subnet: string): Net | undefined {
  const c = parseCidr(subnet.trim());
  if (!c || c.prefix > 30 || c.prefix < 16) return undefined;
  return { cidr: `${intToIp(c.network)}/${c.prefix}`, gw: intToIp(c.network + 1), prefix: c.prefix, first: c.network + 1, last: c.network + c.size - 2 };
}

/** A pool range inside the subnet: "a-b". Falls back to the upper half when the input does not fit. */
function poolIn(n: Net, pool: string | undefined, notes: string[], label: string): string {
  const [a, b] = (pool ?? "").split("-").map((x) => ipToInt(x.trim()));
  if (a !== undefined && b !== undefined && a <= b && a > n.first && b <= n.last) return `${intToIp(a)}-${intToIp(b)}`;
  const size = n.last - n.first + 1;
  const start = n.first - 1 + Math.floor(((size + 2) * 100) / 256);
  const end = n.last - 25 > start ? n.last - 25 : n.last;
  const range = `${intToIp(start)}-${intToIp(end)}`;
  if (pool) notes.push(`The ${label} pool "${pool}" is not inside ${n.cidr}; the script uses ${range} instead.`);
  return range;
}

const BAND = { ax: { b2: "2ghz-ax", b5: "5ghz-ax" }, ac: { b2: "2ghz-n", b5: "5ghz-ac" } } as const;

export function generateSetup(input: SetupOptions): SetupResult {
  const o = input;
  const notes: string[] = [];
  const L: string[] = [];
  const line = (...xs: string[]) => L.push(...xs);
  const blank = () => L.push("");
  const section = (title: string) => {
    blank();
    line(`# ---- ${title} ${"-".repeat(Math.max(4, 64 - title.length))}`);
  };

  // ---- normalise inputs ------------------------------------------------------------------
  const fallback = defaultSetupOptions(o.preset);
  let lan = net(o.lan.subnet);
  if (!lan) {
    notes.push(`"${o.lan.subnet}" is not a usable LAN subnet (use a /16 to /30); the script uses ${fallback.lan.subnet}.`);
    lan = net(fallback.lan.subnet)!;
  }
  const lanPool = poolIn(lan, o.lan.pool, notes, "LAN");
  const ports = o.ports.length ? o.ports : fallback.ports;
  const wanPort = ports.includes(o.wan.port) ? o.wan.port : ports[0]!;
  const lanPorts = ports.filter((p) => p !== wanPort);
  const officeWord = o.preset === "office";
  const iotName = officeWord ? "devices" : "iot";
  const iotLabel = officeWord ? "Devices" : "IoT";

  const side = (s: SideNetwork, label: string, fb: SideNetwork) => {
    if (!s.enabled) return undefined;
    let n = net(s.subnet);
    if (!n) {
      notes.push(`"${s.subnet}" is not a usable ${label} subnet; the script uses ${fb.subnet}.`);
      n = net(fb.subnet)!;
    }
    const vlan = Number.isInteger(s.vlan) && s.vlan >= 2 && s.vlan <= 4094 ? s.vlan : fb.vlan;
    if (vlan !== s.vlan) notes.push(`VLAN ${s.vlan} is not valid for the ${label} network (2–4094); the script uses ${vlan}.`);
    return { ...n, vlan, ssid: s.ssid.trim() };
  };
  const guest = side(o.guest, "guest", fallback.guest);
  const iot = side(o.iot, iotLabel, fallback.iot);
  if (guest && iot && guest.vlan === iot.vlan) notes.push(`Guest and ${iotLabel} use the same VLAN ${guest.vlan}; give them different VLAN ids.`);
  const overlap = [guest, iot].filter((x) => x && (x.cidr === lan.cidr));
  if (overlap.length) notes.push("A side network uses the same subnet as the LAN; give each network its own subnet.");

  const admin = (o.adminSubnet && parseCidr(o.adminSubnet.trim()) ? o.adminSubnet.trim() : undefined) ?? lan.cidr;
  if (o.adminSubnet && admin === lan.cidr && o.adminSubnet.trim() !== lan.cidr) notes.push(`"${o.adminSubnet}" is not a valid admin subnet; management is limited to the LAN (${lan.cidr}).`);
  const wanIf = o.wan.type === "pppoe" ? "pppoe-out1" : wanPort;
  const sides = [guest && { ...guest, key: "guest", label: "Guest", iface: `vlan${guest.vlan}-guest` }, iot && { ...iot, key: iotName, label: iotLabel, iface: `vlan${iot.vlan}-${iotName}` }].filter(
    (x): x is NonNullable<typeof x> => !!x,
  );
  const trunk = (o.apPorts.length ? o.apPorts.filter((p) => lanPorts.includes(p)) : lanPorts).join(",");
  const upstreams = o.dns.upstreams.map((s) => s.trim()).filter((s) => ipToInt(s) !== undefined);
  const dnsUp = upstreams.length ? upstreams : ["1.1.1.1", "9.9.9.9"];
  const lanDns = o.dns.mode === "lan-server" && o.dns.lanServer && ipToInt(o.dns.lanServer.trim()) !== undefined ? o.dns.lanServer.trim() : undefined;
  if (o.dns.mode === "lan-server" && !lanDns) notes.push("No valid LAN DNS server was given, so clients use the router for DNS.");
  const w = o.wifi;
  const bands = BAND[w.gen];
  const country = w.country.trim();
  const countryArg = country ? ` country=${rosQuote(country)}` : "";
  if (w.enabled && !country) notes.push("No Wi-Fi country is set, so the radios keep their factory region, which may not allow your local channels or power. Fill in the country the router is in.");

  // ---- header ------------------------------------------------------------------------------
  const included = [
    `WAN ${o.wan.type === "pppoe" ? "PPPoE" : "DHCP"} on ${wanPort}`,
    `LAN ${lan.cidr}`,
    ...sides.map((s) => `${s.label} VLAN ${s.vlan} (${s.cidr})`),
    w.enabled ? "CAPsMAN Wi-Fi" : "",
    "defconf-style firewall",
    o.nightlyExport ? "nightly export" : "",
  ].filter(Boolean);
  line(
    `# Stribog: clean ${officeWord ? "small-office" : "home"} setup for MikroTik RouterOS v7.15+ (wifi package, CAPsMAN)`,
    "# For a router reset with no default configuration; review every line.",
    "#   /system reset-configuration no-defaults=yes   (then connect with WinBox over MAC)",
    `# Includes: ${included.join(", ")}.`,
    "# Secrets are NOT in this script. Set the admin password, Wi-Fi passphrases" + (o.wan.type === "pppoe" ? " and the PPPoE password" : "") + " yourself.",
    "# Stribog never applies changes; paste this into the router terminal only when you are happy with it.",
  );

  // ---- identity ----------------------------------------------------------------------------
  section("Identity and clock");
  line(`/system identity set name=${rosQuote(ident(o.identity, "gateway"))}`);
  const tz = o.timezone.trim().replace(/[^A-Za-z0-9_/+-]/g, "");
  if (tz) line(`/system clock set time-zone-autodetect=no time-zone-name=${tz}`);

  // ---- bridge, ports, VLANs ----------------------------------------------------------------
  section("Bridge and ports");
  line(
    "# One bridge for all LAN ports. VLAN filtering is switched on at the very end,",
    "# after every VLAN is defined, so the session is never cut off half-way.",
    "/interface bridge",
    `add name=bridge comment="LAN" vlan-filtering=no`,
    "/interface bridge port",
    ...lanPorts.map((p) => `add bridge=bridge interface=${p}`),
  );
  line("/interface ethernet", `set [ find default-name=${wanPort} ] comment="WAN"`);
  if (sides.length) {
    section("VLANs");
    line("/interface vlan", ...sides.map((s) => `add name=${s.iface} interface=bridge vlan-id=${s.vlan} comment=${rosQuote(`${s.label} network`)}`));
    line(
      `# ${plural(sides.length, "VLAN")} tagged towards the router itself and the access point ports`,
      "/interface bridge vlan",
      ...sides.map((s) => `add bridge=bridge vlan-ids=${s.vlan} tagged=bridge${trunk ? `,${trunk}` : ""} comment=${rosQuote(s.label)}`),
    );
    if (!o.apPorts.length)
      notes.push(`The ${sides.map((x) => x.label).join(" and ")} VLAN${sides.length > 1 ? "s are" : " is"} tagged on every LAN port. Once you know where the access points are, limit "tagged=" to those ports so a wired device cannot join ${sides.length > 1 ? "them" : "it"}.`);
  }

  // ---- WAN ---------------------------------------------------------------------------------
  section("Internet (WAN)");
  if (o.wan.type === "pppoe") {
    const user = o.wan.pppoeUser?.trim() || "user@isp";
    line(
      "/interface pppoe-client",
      `add name=pppoe-out1 interface=${wanPort} user=${rosQuote(user)} add-default-route=yes use-peer-dns=no disabled=no comment="WAN"`,
      `# Set the password on the router:  /interface pppoe-client set pppoe-out1 password="…"`,
    );
    notes.push("Set the PPPoE password on the router after pasting; the script leaves it empty so it never ends up in a file or chat.");
    if (!o.wan.pppoeUser?.trim()) notes.push('No PPPoE username was given; replace "user@isp" with the one from your ISP.');
  } else {
    line("/ip dhcp-client", `add interface=${wanPort} use-peer-dns=no add-default-route=yes disabled=no comment="WAN"`);
  }

  // ---- interface lists ---------------------------------------------------------------------
  section("Interface lists");
  line(
    sides.length ? "# LAN = trusted. LIMITED = guest/IoT: internet plus DNS and DHCP from the router, nothing else." : "# LAN = trusted, WAN = the internet side. The firewall below is written in terms of these lists.",
    "/interface list",
    "add name=WAN comment=\"Internet side\"",
    "add name=LAN comment=\"Trusted networks\"",
  );
  if (sides.length) line('add name=LIMITED comment="Internet-only networks"');
  line("/interface list member", `add list=WAN interface=${wanPort}`);
  if (o.wan.type === "pppoe") line("add list=WAN interface=pppoe-out1");
  line("add list=LAN interface=bridge", ...sides.map((s) => `add list=LIMITED interface=${s.iface}`));

  // ---- addresses, DHCP, DNS ----------------------------------------------------------------
  section("Addresses and DHCP");
  const all = [{ key: "lan", label: "LAN", iface: "bridge", ...lan, pool: lanPool, lease: o.lan.leaseTime.trim() || "1d" }, ...sides.map((s) => ({ ...s, pool: poolIn(s, undefined, notes, s.label), lease: s.key === "guest" ? "1h" : "1d" }))];
  line("/ip address", ...all.map((n) => `add address=${n.gw}/${n.prefix} interface=${n.iface} comment=${rosQuote(n.label)}`));
  line("/ip pool", ...all.map((n) => `add name=pool-${n.key} ranges=${n.pool}`));
  line("/ip dhcp-server", ...all.map((n) => `add name=dhcp-${n.key} interface=${n.iface} address-pool=pool-${n.key} lease-time=${n.lease} disabled=no`));
  line(
    "/ip dhcp-server network",
    ...all.map((n) => {
      const dns = n.key === "lan" && lanDns ? `${lanDns},${n.gw}` : n.gw;
      return `add address=${n.cidr} gateway=${n.gw} dns-server=${dns} comment=${rosQuote(n.label)}`;
    }),
  );

  section("DNS");
  line(
    `# The router resolves through ${dnsUp.join(" and ")}; allow-remote-requests is safe because the firewall drops DNS from the WAN.`,
    `/ip dns set servers=${dnsUp.join(",")} allow-remote-requests=yes cache-size=4096KiB`,
    "/ip dns static",
    `add name=router.lan address=${lan.gw} comment="This router"`,
  );
  if (lanDns) {
    notes.push(`LAN clients get ${lanDns} first and the router (${lan.gw}) as fallback, so DNS keeps working when ${lanDns} is down. While both are up, some lookups will go to the router and skip any filtering on ${lanDns}.`);
    if (sides.length) notes.push(`${sides.map((x) => x.label).join(" and ")} clients use the router for DNS: they are not allowed to reach ${lanDns} on the LAN.`);
  }

  // ---- firewall ----------------------------------------------------------------------------
  section("Firewall: router access (input)");
  line(
    "/ip firewall filter",
    'add chain=input action=accept connection-state=established,related,untracked comment="accept established,related,untracked"',
    'add chain=input action=drop connection-state=invalid comment="drop invalid"',
    'add chain=input action=accept protocol=icmp comment="accept ICMP"',
    'add chain=input action=accept dst-address=127.0.0.1 src-address=127.0.0.1 in-interface=lo comment="accept to local loopback (for CAPsMAN)"',
  );
  if (sides.length)
    line(
      'add chain=input action=accept in-interface-list=LIMITED protocol=udp dst-port=53,67 comment="guest/IoT: DNS and DHCP only"',
      'add chain=input action=accept in-interface-list=LIMITED protocol=tcp dst-port=53 comment="guest/IoT: DNS over TCP"',
    );
  line(
    'add chain=input action=accept in-interface-list=LAN comment="accept from LAN"',
    'add chain=input action=drop comment="drop everything else"',
  );

  section("Firewall: traffic through the router (forward)");
  line(
    "/ip firewall filter",
    'add chain=forward action=accept ipsec-policy=in,ipsec comment="accept in ipsec policy"',
    'add chain=forward action=accept ipsec-policy=out,ipsec comment="accept out ipsec policy"',
    'add chain=forward action=fasttrack-connection connection-state=established,related hw-offload=yes comment="fasttrack"',
    'add chain=forward action=accept connection-state=established,related,untracked comment="accept established,related,untracked"',
    'add chain=forward action=drop connection-state=invalid comment="drop invalid"',
    'add chain=forward action=drop connection-nat-state=!dstnat in-interface-list=WAN comment="drop all from WAN not DSTNATed"',
  );
  for (const sd of sides) {
    if (sd.key === "guest") {
      line(`add chain=forward action=drop in-interface=${sd.iface} out-interface-list=!WAN comment="guest: internet only"`);
      line(`add chain=forward action=drop out-interface=${sd.iface} in-interface-list=!WAN comment="guest: nothing else may reach it"`);
    } else {
      line(`add chain=forward action=drop in-interface=${sd.iface} out-interface-list=!WAN comment=${rosQuote(`${sd.label.toLowerCase()}: cannot start connections to other networks`)}`);
      if (!o.iot.lanCanReach) line(`add chain=forward action=drop out-interface=${sd.iface} in-interface-list=LAN comment=${rosQuote(`${sd.label.toLowerCase()}: the LAN cannot reach it either`)}`);
    }
  }

  section("NAT");
  line("/ip firewall nat", 'add chain=srcnat action=masquerade out-interface-list=WAN ipsec-policy=out,none comment="masquerade to the internet"');
  notes.push("IPv6 is not configured. Before enabling it, add the defconf IPv6 firewall (it is not the same as the IPv4 one).");

  // ---- Wi-Fi -------------------------------------------------------------------------------
  if (w.enabled) {
    section("Wi-Fi via CAPsMAN");
    const auth = w.security === "wpa3" ? "wpa3-psk" : "wpa2-psk,wpa3-psk";
    const iotWifi = sides.find((x) => x.key === iotName && x.ssid);
    const guestWifi = sides.find((x) => x.key === "guest" && x.ssid);
    line(
      "# Channel plan: 2.4 GHz on 1/6/11 at 20 MHz (the only non-overlapping set), 5 GHz " +
        (w.allowDfs ? "including radar (DFS) channels, minus the 10-minute weather-radar ones." : "on non-radar channels only."),
      "/interface wifi channel",
      `add name=ch-2g band=${bands.b2} width=20mhz frequency=2412,2437,2462`,
      `add name=ch-5g band=${bands.b5} width=${w.width5} skip-dfs-channels=${w.allowDfs ? "10min-cac" : "all"}`,
      "# Passphrases are left unset on purpose; set them on the router (see the notes).",
      "/interface wifi security",
      `add name=sec-main authentication-types=${auth} ft=yes ft-over-ds=yes`,
    );
    if (guestWifi) line(`add name=sec-guest authentication-types=${auth}`);
    if (iotWifi) line(`add name=sec-${iotName} authentication-types=wpa2-psk`);
    line(
      "/interface wifi datapath",
      'add name=dp-main bridge=bridge comment="LAN, untagged"',
      ...(guestWifi ? [`add name=dp-guest bridge=bridge vlan-id=${guestWifi.vlan}${o.guest.isolation ? " client-isolation=yes" : ""} comment="Guest VLAN"`] : []),
      ...(iotWifi ? [`add name=dp-${iotName} bridge=bridge vlan-id=${iotWifi.vlan} comment=${rosQuote(`${iotLabel} VLAN`)}`] : []),
      "/interface wifi configuration",
      `add name=cfg-main-2g ssid=${rosQuote(w.ssid.trim() || "Home")}${countryArg} security=sec-main datapath=dp-main channel=ch-2g mode=ap`,
      `add name=cfg-main-5g ssid=${rosQuote(w.ssid.trim() || "Home")}${countryArg} security=sec-main datapath=dp-main channel=ch-5g mode=ap`,
    );
    if (guestWifi) line(`add name=cfg-guest ssid=${rosQuote(guestWifi.ssid)}${countryArg} security=sec-guest datapath=dp-guest mode=ap`);
    if (iotWifi) line(`add name=cfg-${iotName} ssid=${rosQuote(iotWifi.ssid)}${countryArg} security=sec-${iotName} datapath=dp-${iotName} mode=ap`);
    const slaves2 = [guestWifi && "cfg-guest", iotWifi && `cfg-${iotName}`].filter(Boolean).join(",");
    const slaves5 = [guestWifi && "cfg-guest"].filter(Boolean).join(",");
    line(
      `# Every access point gets the main SSID on both bands${guestWifi ? ", guest on both" : ""}${iotWifi ? `, ${iotLabel} on 2.4 GHz only (most such devices are 2.4-only)` : ""}.`,
      "/interface wifi provisioning",
      `add action=create-dynamic-enabled supported-bands=${bands.b2} master-configuration=cfg-main-2g${slaves2 ? ` slave-configurations=${slaves2}` : ""} name-format=%I-2g`,
      `add action=create-dynamic-enabled supported-bands=${bands.b5} master-configuration=cfg-main-5g${slaves5 ? ` slave-configurations=${slaves5}` : ""} name-format=%I-5g`,
      "/interface wifi capsman",
      "set enabled=yes interfaces=bridge upgrade-policy=suggest-same-version",
    );
    const secs = ["sec-main", guestWifi && "sec-guest", iotWifi && `sec-${iotName}`].filter(Boolean) as string[];
    notes.push(`Set the Wi-Fi passphrases on the router: ${secs.map((x) => `/interface wifi security set ${x} passphrase="…"`).join(" · ")}. The script never contains a passphrase, so no network can come up with a key that was shared in a file or chat.`);
    if (w.security === "wpa3") notes.push("WPA3-only keeps out older phones, printers and TVs. Choose WPA2/WPA3 if anything fails to join.");
    if (w.gen === "ac") notes.push("Wi-Fi 5 (ac) access points need the wifi-qcom-ac package to work with this CAPsMAN.");
    if (w.allowDfs) notes.push("Radar (DFS) channels give 5 GHz more room, but an access point goes quiet for a minute after start-up or when it detects radar.");
    if (w.width5 === "20/40/80/160mhz") notes.push("160 MHz uses most of the 5 GHz band; one neighbour on an overlapping channel slows everyone down. 80 MHz is the safer default.");
    if (sides.some((x) => x.ssid))
      L.push(
        "",
        "# On each access point (reset in CAP mode), carry the VLANs on its uplink:",
        "#   /interface bridge set [find] vlan-filtering=yes",
        `#   /interface bridge vlan add bridge=bridge tagged=ether1 vlan-ids=${sides.map((x) => x.vlan).join(",")}`,
        "#   /interface wifi datapath add name=capdp bridge=bridge",
        "#   /interface wifi cap set enabled=yes discovery-interfaces=bridge slaves-datapath=capdp",
      );
  }

  // ---- management --------------------------------------------------------------------------
  section("Management");
  line(
    `# WebFig, SSH and WinBox answer only from ${admin}; clear-text and API services are off.`,
    "/ip service",
    "set telnet disabled=yes",
    "set ftp disabled=yes",
    "set api disabled=yes",
    "set api-ssl disabled=yes",
    `set www address=${admin}`,
    `set ssh address=${admin}`,
    `set winbox address=${admin}`,
    "/ip ssh set strong-crypto=yes forwarding-enabled=no",
    "/ip neighbor discovery-settings set discover-interface-list=LAN",
    "/tool mac-server set allowed-interface-list=LAN",
    "/tool mac-server mac-winbox set allowed-interface-list=LAN",
    "/ip upnp set enabled=no",
  );
  notes.push(`Set a strong admin password (/user set admin password="…") or create your own admin user and disable "admin". Manage from ${admin}${admin === lan.cidr ? " (the LAN)" : ""}, or you will lock yourself out of WebFig, SSH and WinBox.`);

  section("Time and backups");
  const ntp = o.ntp.map((s) => s.trim()).filter(Boolean);
  line("/system ntp client set enabled=yes", "/system ntp client servers", ...(ntp.length ? ntp : ["pool.ntp.org"]).map((s) => `add address=${s}`));
  if (o.nightlyExport) {
    line(
      "/system scheduler",
      'add name=nightly-export interval=1d start-time=03:30:00 policy=ftp,read,write,policy,test on-event="/export file=nightly-export" comment="Config export without secrets"',
    );
    notes.push("The nightly export stays on the router. Copy nightly-export.rsc somewhere else (for example with scp from a NAS) so a dead router does not take the backup with it.");
  }

  // ---- enable VLAN filtering last ----------------------------------------------------------
  section("Finally");
  line("# Switch VLAN filtering on now that every VLAN exists.", "/interface bridge set bridge vlan-filtering=yes");

  return { script: L.join("\n").replace(/\n{3,}/g, "\n\n") + "\n", notes };
}

const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`);
