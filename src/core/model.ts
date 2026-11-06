// Builds one honest picture of the network from RouterOS snapshots.
//
// Every derived fact keeps track of how it is known: read from the router, inferred, or told by
// the user. The UI uses that to say "probably" instead of pretending.

import { KIND_LABEL, kindFromText, likelyOnly24, shortName, vendorOf, type DeviceKind } from "./classify.ts";
import {
  bandFromRos,
  cidrString,
  inCidr,
  inPool,
  isCgnatIp,
  isPrivateIp,
  normMac,
  parseChannelStatus,
  parseSignal,
  poolSize,
  rateMbps,
  type Band,
} from "./net.ts";
import {
  enabled,
  isTrue,
  list,
  menu,
  prop,
  single,
  type DeviceNotes,
  type DeviceSnapshot,
  type NetworkRole,
  type Notes,
  type PlannedDevice,
  type RosConfig,
  type RosRecord,
  type ServiceNote,
  type Snapshot,
  type SourceInfo,
} from "./ros.ts";

export type Certainty = "read" | "inferred" | "user";

export interface Connection {
  kind: "port" | "wifi" | "upstream";
  /** Router port, or the port on the parent device. */
  port?: string;
  ssid?: string;
  band?: Band;
  signal?: number;
  txRate?: string;
  rxRate?: string;
  /** Current throughput towards the device and from it, bits per second (Wi-Fi: from the registration table). */
  downBps?: number;
  upBps?: number;
  radio?: string;
  certainty: Certainty;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  kindCertainty: Certainty;
  name: string;
  nameSource: "user" | "identity" | "comment" | "hostname" | "vendor" | "mac" | "system";
  mac?: string;
  ip?: string;
  hostname?: string;
  vendor?: string;
  model?: string;
  version?: string;
  privateMac?: boolean;
  reserved?: boolean;
  leaseComment?: string;
  network?: string;
  zone: "internet" | "upstream" | "lan";
  status: "online" | "offline" | "unknown" | "planned";
  managed?: boolean;
  parent?: string;
  via?: Connection;
  /** From notes: labels, a short description, what runs on it, and free-form notes. */
  labels?: string[];
  description?: string;
  services?: ServiceNote[];
  notes?: string;
  only24?: boolean;
  lastSeen?: string;
  facts: string[];
}

export interface Port {
  name: string;
  defaultName: string;
  comment?: string;
  bridge?: string;
  network?: string;
  zone: "lan" | "upstream" | "none";
  poe?: string;
  poeWatts?: number;
  poeVolts?: number;
  speedMbps?: number;
  /** Current throughput, bits per second, as the router port sees it: rx is from the device, tx towards it. */
  rxBps?: number;
  txBps?: number;
  running?: boolean;
  hwOffload?: boolean;
  deviceIds: string[];
  planned?: string;
  kind: "ethernet" | "sfp";
}

export interface Dhcp {
  server: string;
  pool: string[];
  size: number;
  used?: number;
  leaseTime?: string;
  dns: string[];
  ntp: string[];
  gateway?: string;
}

export interface Network {
  id: string;
  name: string;
  label: string;
  bridge: string;
  cidr?: string;
  gateway?: string;
  role: NetworkRole;
  dhcp?: Dhcp;
  ssids: string[];
  comment?: string;
  vlan?: number;
}

export interface Ssid {
  name: string;
  bands: Band[];
  auth: string[];
  ft: boolean;
  network?: string;
  configs: string[];
  aps: string[];
  clients: number;
  country?: string;
  hidden?: boolean;
  security?: string;
}

export interface Radio {
  id: string;
  apId: string;
  iface: string;
  band: Band;
  ssids: string[];
  plan?: { frequencies: number[]; width?: string; skipDfs?: boolean };
  current?: { freq: number; channel: number; width: number; dfs: boolean };
  clients: number;
}

export interface Wan {
  iface?: string;
  type: "dhcp" | "pppoe" | "static" | "unknown";
  address?: string;
  gateway?: string;
  addressKind?: "public" | "private" | "cgnat";
  doubleNat: boolean | "unknown";
  doubleNatCertainty?: Certainty;
  upstreamName?: string;
}

export interface NetworkModel {
  site: string;
  generatedAt: string;
  sources: SourceInfo[];
  hasState: boolean;
  sampleState: boolean;
  routerId?: string;
  devices: Device[];
  ports: Port[];
  networks: Network[];
  ssids: Ssid[];
  radios: Radio[];
  wan: Wan;
  planned: PlannedDevice[];
  /** The router's time zone (/system/clock), when it reports one. */
  timezone?: string;
  /** Management services (/ip service), defaults filled in. */
  services?: Service[];
  /** IPv4 firewall rules in router order, reduced to the fields the UI explains. */
  firewall?: { filter: FwRule[]; nat: FwRule[] };
}

export interface Service {
  name: string;
  enabled: boolean;
  /** Allowed source addresses; absent means any. */
  address?: string;
  port?: string;
}

/** A firewall rule as RouterOS stores it, limited to the fields worth explaining. */
export interface FwRule {
  chain: string;
  action: string;
  comment?: string;
  disabled?: boolean;
  protocol?: string;
  "src-port"?: string;
  "dst-port"?: string;
  "src-address"?: string;
  "dst-address"?: string;
  "src-address-list"?: string;
  "dst-address-list"?: string;
  "in-interface"?: string;
  "out-interface"?: string;
  "in-interface-list"?: string;
  "out-interface-list"?: string;
  "connection-state"?: string;
  "connection-nat-state"?: string;
  "ipsec-policy"?: string;
  "to-addresses"?: string;
  "to-ports"?: string;
  "jump-target"?: string;
}

const FW_FIELDS = [
  "protocol", "src-port", "dst-port", "src-address", "dst-address", "src-address-list", "dst-address-list",
  "in-interface", "out-interface", "in-interface-list", "out-interface-list", "connection-state",
  "connection-nat-state", "ipsec-policy", "to-addresses", "to-ports", "jump-target",
] as const;

function fwRule(r: RosRecord): FwRule {
  const out: FwRule = { chain: r.chain ?? "", action: r.action ?? "accept" };
  if (r.comment) out.comment = r.comment;
  if (isTrue(r.disabled)) out.disabled = true;
  for (const k of FW_FIELDS) if (r[k]) out[k] = r[k];
  return out;
}

/** RouterOS defaults: exports only list services that differ from these. */
const SERVICE_DEFAULTS: [string, string, boolean][] = [
  ["telnet", "23", true], ["ftp", "21", true], ["www", "80", true], ["ssh", "22", true],
  ["www-ssl", "443", false], ["api", "8728", true], ["winbox", "8291", true], ["api-ssl", "8729", true],
];

function servicesOf(cfg: RosConfig | undefined): Service[] | undefined {
  if (!cfg) return undefined;
  const recs = menu(cfg, "/ip/service");
  const out: Service[] = SERVICE_DEFAULTS.map(([name, port, on]) => {
    const r = recs.find((x) => x.name === name);
    const address = r?.address && r.address !== "0.0.0.0/0" ? r.address : undefined;
    return { name, enabled: r?.disabled !== undefined ? !isTrue(r.disabled) : on, ...(address ? { address } : {}), port: r?.port ?? port };
  });
  // Anything else the router reports (newer RouterOS adds services over time).
  for (const r of recs) {
    if (!r.name || out.some((s) => s.name === r.name)) continue;
    const address = r.address && r.address !== "0.0.0.0/0" ? r.address : undefined;
    out.push({ name: r.name, enabled: !isTrue(r.disabled), ...(address ? { address } : {}), ...(r.port ? { port: r.port } : {}) });
  }
  return out;
}

const ROUTER_PORTS: Record<string, string[]> = {
  RB5009: ["ether1", "ether2", "ether3", "ether4", "ether5", "ether6", "ether7", "ether8", "sfp-sfpplus1"],
};

const portSort = (a: string, b: string) => {
  const na = Number(a.match(/\d+$/)?.[0] ?? 999);
  const nb = Number(b.match(/\d+$/)?.[0] ?? 999);
  const sa = a.startsWith("sfp") ? 1 : 0;
  const sb = b.startsWith("sfp") ? 1 : 0;
  return sa - sb || na - nb || a.localeCompare(b);
};

export function buildModel(snap: Snapshot): NetworkModel {
  const ov: Notes = snap.notes ?? {};
  const routerSnap = snap.devices.find((d) => d.role === "router");
  const capSnaps = snap.devices.filter((d) => d.role === "cap");
  const cfg = routerSnap?.config;
  const st = routerSnap?.state ?? {};
  const hasState = snap.devices.some((d) => d.state && Object.keys(d.state).length > 0);
  const stateMenu = (p: string) => st[p] ?? [];

  const devices = new Map<string, Device>();
  const add = (d: Device) => {
    devices.set(d.id, d);
    return d;
  };

  // ---- interface lists, bridges, networks -------------------------------
  const lists = new Map<string, Set<string>>();
  for (const m of menu(cfg, "/interface/list/member")) {
    if (!enabled(m)) continue;
    const l = m.list ?? "";
    if (!lists.has(l)) lists.set(l, new Set());
    lists.get(l)!.add(m.interface ?? "");
  }
  const inList = (iface: string, l: string) => lists.get(l)?.has(iface) ?? false;

  const bridgePorts = menu(cfg, "/interface/bridge/port").filter(enabled);
  const bridgeOf = (iface: string) => bridgePorts.find((p) => p.interface === iface)?.bridge;
  const zoneOfIface = (iface: string | undefined): Port["zone"] => {
    if (!iface) return "none";
    const b = bridgeOf(iface) ?? iface;
    if (inList(b, "WAN") || inList(iface, "WAN")) return "upstream";
    if (inList(b, "LAN") || inList(iface, "LAN")) return "lan";
    return "none";
  };

  const addresses = menu(cfg, "/ip/address").filter(enabled);
  const pools = new Map(menu(cfg, "/ip/pool").map((p) => [p.name ?? "", list(p.ranges)]));
  const dhcpServers = menu(cfg, "/ip/dhcp-server").filter(enabled);
  const dhcpNetworks = menu(cfg, "/ip/dhcp-server/network");
  const leasesCfg = menu(cfg, "/ip/dhcp-server/lease");
  const leasesState = stateMenu("/ip/dhcp-server/lease");

  const networks: Network[] = [];
  for (const br of menu(cfg, "/interface/bridge")) {
    const name = br.name ?? "bridge";
    const addr = addresses.find((a) => a.interface === name && !isLegacyAlias(a));
    const isWan = inList(name, "WAN");
    const role: NetworkRole = ov.networks?.[name]?.role ?? (isWan ? "wan" : guessRole(name, br.comment));
    const net: Network = {
      id: name,
      name,
      label: ov.networks?.[name]?.label ?? labelFor(name, br.comment, role),
      bridge: name,
      role,
      ssids: [],
      comment: br.comment,
    };
    if (addr?.address) {
      net.cidr = cidrString(addr.address);
      net.gateway = addr.address.split("/")[0];
    }
    const srv = dhcpServers.find((s) => s.interface === name);
    if (srv) {
      const pool = pools.get(srv["address-pool"] ?? "") ?? [];
      const dn = dhcpNetworks.find((n) => net.cidr && n.address && cidrString(n.address) === net.cidr);
      const leasesHere = leasesState.length
        ? leasesState.filter((l) => l.server === srv.name && (l.status === "bound" || !l.status))
        : [];
      net.dhcp = {
        server: srv.name ?? "",
        pool,
        size: poolSize(pool),
        used: leasesState.length ? leasesHere.filter((l) => inPool(l.address ?? "", pool)).length : undefined,
        leaseTime: srv["lease-time"] ?? "30m",
        dns: list(dn?.["dns-server"]),
        ntp: list(dn?.["ntp-server"]),
        gateway: dn?.gateway,
      };
    }
    networks.push(net);
  }
  // VLAN interfaces with addresses also form networks.
  for (const v of menu(cfg, "/interface/vlan")) {
    const name = v.name ?? "";
    const addr = addresses.find((a) => a.interface === name);
    const role: NetworkRole = ov.networks?.[name]?.role ?? guessRole(name, v.comment);
    networks.push({
      id: name,
      name,
      label: ov.networks?.[name]?.label ?? labelFor(name, v.comment, role),
      bridge: v.interface ?? "",
      role,
      ssids: [],
      vlan: Number(v["vlan-id"]) || undefined,
      cidr: addr?.address ? cidrString(addr.address) : undefined,
      gateway: addr?.address?.split("/")[0],
      comment: v.comment,
    });
  }
  const lanNet = networks.find((n) => n.role === "lan") ?? networks.find((n) => n.role !== "wan");
  const networkOfIp = (ip?: string) => (ip ? networks.find((n) => n.cidr && inCidr(ip, n.cidr))?.id : undefined);

  // ---- WAN ---------------------------------------------------------------
  const dhcpClient = menu(cfg, "/ip/dhcp-client").find((c) => enabled(c) && zoneOfIface(c.interface) === "upstream");
  const pppoe = menu(cfg, "/interface/pppoe-client").find(enabled);
  const wanState = stateMenu("/ip/dhcp-client").find((c) => c.interface === dhcpClient?.interface);
  const wan: Wan = {
    iface: pppoe?.name ?? dhcpClient?.interface,
    type: pppoe ? "pppoe" : dhcpClient ? "dhcp" : "unknown",
    doubleNat: "unknown",
    upstreamName: ov.upstream?.name,
  };
  const wanAddr = wanState?.address?.split("/")[0];
  if (wanAddr) {
    wan.address = wanAddr;
    wan.gateway = wanState?.gateway;
    wan.addressKind = isCgnatIp(wanAddr) ? "cgnat" : isPrivateIp(wanAddr) ? "private" : "public";
    wan.doubleNat = wan.addressKind !== "public";
    wan.doubleNatCertainty = "read";
  } else {
    // An export has no lease, but private addresses on the WAN side give it away.
    const wanSideAddr = addresses.find((a) => zoneOfIface(a.interface) === "upstream" && a.address && isPrivateIp(a.address.split("/")[0]!));
    if (wanSideAddr) {
      wan.doubleNat = true;
      wan.doubleNatCertainty = "inferred";
      wan.addressKind = "private";
    }
  }

  // ---- Internet, upstream, router ------------------------------------------
  add({
    id: "internet",
    kind: "internet",
    kindCertainty: "read",
    name: "Internet",
    nameSource: "system",
    zone: "internet",
    status: hasState ? "online" : "unknown",
    facts: [],
  });

  // The box in front of the router, when there is one: a private WAN address says so.
  // Its MAC comes from the router's ARP entry for the WAN gateway.
  const gwArp = wan.gateway ? stateMenu("/ip/arp").find((a) => a.address === wan.gateway && a["mac-address"]) : undefined;
  const gwMac = normMac(gwArp?.["mac-address"]);
  if (wan.doubleNat === true || ov.upstream) {
    const named = ov.upstream?.model ?? ov.upstream?.name;
    const v = gwMac ? vendorOf(gwMac) : undefined;
    add({
      id: "upstream",
      kind: "isp",
      kindCertainty: ov.upstream ? "user" : "inferred",
      name: named ?? "ISP router",
      nameSource: named ? "user" : "system",
      mac: gwMac || undefined,
      vendor: v?.vendor,
      ip: wan.gateway,
      model: ov.upstream?.model,
      zone: "upstream",
      status: hasState ? "online" : "unknown",
      parent: "internet",
      via: { kind: "upstream", certainty: "inferred" },
      facts: [
        ov.upstream?.isp ? `ISP: ${ov.upstream.isp}` : "",
        wan.gateway ? `Gateway for the router's WAN` : "",
        v?.vendor ? `Probably made by ${v.vendor}, from its MAC address` : "",
      ].filter(Boolean),
    });
  }

  let routerId: string | undefined;
  if (routerSnap) {
    const res = stateMenu("/system/resource")[0];
    const rb = stateMenu("/system/routerboard")[0];
    const identity = prop(single(cfg, "/system/identity"), "name", "MikroTik");
    const model = rb?.model ?? res?.["board-name"] ?? cfg?.meta.model;
    const lanAddr = lanNet?.gateway;
    routerId = "router";
    add({
      id: routerId,
      kind: "router",
      kindCertainty: "read",
      name: identity === "MikroTik" && model ? (model.match(/^[A-Za-z]+\d+/)?.[0] ?? model) : identity,
      nameSource: identity === "MikroTik" ? "system" : "identity",
      ip: lanAddr,
      vendor: "MikroTik",
      model,
      version: res?.version?.split(" ")[0] ?? cfg?.meta.version,
      zone: "lan",
      status: hasState ? "online" : "unknown",
      managed: true,
      parent: devices.has("upstream") ? "upstream" : "internet",
      via: { kind: "upstream", certainty: "read" },
      facts: [identity === "MikroTik" ? "Identity is still the default \"MikroTik\"" : `Identity ${identity}`],
    });
  }

  // ---- ports ---------------------------------------------------------------
  const ethernet = menu(cfg, "/interface/ethernet");
  const modelKey = Object.keys(ROUTER_PORTS).find((k) => (cfg?.meta.model ?? "").startsWith(k));
  const portNames = new Set<string>([
    ...(modelKey ? ROUTER_PORTS[modelKey]! : []),
    ...ethernet.map((e) => e["default-name"] ?? e.name ?? ""),
    ...bridgePorts.map((p) => p.interface ?? "").filter((n) => /^(ether|sfp|combo|qsfp)/.test(n)),
  ]);
  const monitor = stateMenu("/interface/ethernet/monitor");
  const poeMon = stateMenu("/interface/ethernet/poe/monitor");
  const trafficMon = stateMenu("/interface/monitor-traffic");
  const ifState = stateMenu("/interface");
  const ports: Port[] = [...portNames]
    .filter(Boolean)
    .sort(portSort)
    .map((def) => {
      const e = ethernet.find((x) => (x["default-name"] ?? x.name) === def);
      const name = e?.name ?? def;
      const bp = bridgePorts.find((p) => p.interface === name);
      const mon = monitor.find((m) => m.name === name);
      const poe = poeMon.find((m) => m.name === name);
      const traffic = trafficMon.find((m) => m.name === name);
      const ifs = ifState.find((i) => i.name === name);
      const bridge = bp?.bridge;
      return {
        name,
        defaultName: def,
        comment: e?.comment,
        bridge,
        network: bridge ? networks.find((n) => n.bridge === bridge && !n.vlan)?.id : undefined,
        zone: zoneOfIface(name),
        poe: e?.["poe-out"] ?? (modelKey === "RB5009" && def !== "sfp-sfpplus1" ? "auto-on" : undefined),
        poeWatts: poe?.["poe-out-power"] ? Number(poe["poe-out-power"].replace(/[^\d.]/g, "")) : undefined,
        poeVolts: poe?.["poe-out-voltage"] ? Number(poe["poe-out-voltage"].replace(/[^\d.]/g, "")) : undefined,
        speedMbps: mon?.status === "link-ok" ? rateMbps(mon.rate) : undefined,
        rxBps: bps(traffic?.["rx-bits-per-second"]),
        txBps: bps(traffic?.["tx-bits-per-second"]),
        running: mon ? mon.status === "link-ok" : ifs ? isTrue(ifs.running) : undefined,
        hwOffload: bp ? !(bp.hw === "no" || bp.hw === "false") : undefined,
        deviceIds: [],
        kind: def.startsWith("sfp") ? "sfp" : "ethernet",
      } satisfies Port;
    });
  const portByName = (n?: string) => ports.find((p) => p.name === n);

  // ---- access points ---------------------------------------------------------
  // CAPs are known from their own export, from CAPsMAN state, and from notes in the router export.
  const caps = new Map<string, { mac: string; snap?: DeviceSnapshot; remote?: RosRecord }>();
  for (const s of capSnaps) {
    const br = menu(s.config, "/interface/bridge")[0];
    const mac = normMac(br?.["admin-mac"]);
    if (mac) caps.set(mac, { mac, snap: s });
  }
  for (const r of stateMenu("/interface/wifi/capsman/remote-cap")) {
    const mac = normMac(r["base-mac"] ?? r["address"]?.split("%")[0]);
    if (!mac) continue;
    caps.set(mac, { ...(caps.get(mac) ?? { mac }), remote: r });
  }
  for (const w of menu(cfg, "/interface/wifi")) {
    const m = w._notes?.match(/operated by CAP ([0-9A-F:]{17})/i);
    if (m) {
      const mac = normMac(m[1]);
      if (!caps.has(mac)) caps.set(mac, { mac });
    }
  }

  for (const cap of caps.values()) {
    const c = cap.snap?.config;
    const identity = cap.remote?.identity ?? prop(single(c, "/system/identity"), "name", "");
    const lease = leasesCfg.find((l) => normMac(l["mac-address"]) === cap.mac);
    const ovd = ov.devices?.[cap.mac];
    add({
      id: `mac:${cap.mac}`,
      kind: "ap",
      kindCertainty: "read",
      name: ovd?.name ?? (identity || (lease?.comment ? shortName(lease.comment) : `AP ${cap.mac.slice(-5)}`)),
      nameSource: ovd?.name ? "user" : identity ? "identity" : lease ? "comment" : "mac",
      mac: cap.mac,
      ip: lease?.address ?? cap.remote?.address?.split("%")[0],
      vendor: "MikroTik",
      model: cap.remote?.board ?? c?.meta.model,
      version: cap.remote?.version ?? c?.meta.version,
      reserved: !!lease,
      leaseComment: lease?.comment,
      network: lanNet?.id,
      zone: "lan",
      status: cap.remote ? (/ok|run/i.test(cap.remote.state ?? "ok") ? "online" : "offline") : hasState ? "unknown" : "unknown",
      managed: true,
      ...noteFields(ovd),
      facts: [`Managed by CAPsMAN on the router`, c ? `Update channel ${prop(single(c, "/system/package/update"), "channel", "stable")}` : ""].filter(Boolean),
    });
  }
  const apIds = [...caps.keys()].map((m) => `mac:${m}`);

  // ---- Wi-Fi configuration -----------------------------------------------------
  const wifiCfgs = menu(cfg, "/interface/wifi/configuration");
  const secProfiles = menu(cfg, "/interface/wifi/security");
  const chanProfiles = menu(cfg, "/interface/wifi/channel");
  const wifiIfaces = menu(cfg, "/interface/wifi");
  const wifiState = stateMenu("/interface/wifi/monitor");
  const ssids = new Map<string, Ssid>();
  const radios: Radio[] = [];

  const datapaths = menu(cfg, "/interface/wifi/datapath");
  const networkOfConf = (conf: RosRecord) => {
    const vlan = Number(conf["datapath.vlan-id"] ?? datapaths.find((d) => d.name === conf.datapath)?.["vlan-id"]);
    return (vlan && networks.find((n) => n.vlan === vlan)?.id) || lanNet?.id;
  };
  const ssidFor = (confName: string | undefined) => {
    const conf = wifiCfgs.find((c) => c.name === confName);
    if (!conf?.ssid) return undefined;
    const sec = secProfiles.find((s) => s.name === conf.security);
    const ch = chanProfiles.find((c) => c.name === conf.channel);
    // The channel profile or the configuration's own channel band; a name like "home-2g" is the last resort.
    const band = bandFromRos(ch?.band ?? conf["channel.band"]) ?? (/(2g|2ghz|24)/i.test(conf.name ?? "") ? "2.4" : /(5g|5ghz)/i.test(conf.name ?? "") ? "5" : undefined);
    let s = ssids.get(conf.ssid);
    if (!s) {
      s = {
        name: conf.ssid,
        bands: [],
        auth: list(sec?.["authentication-types"] ?? conf["security.authentication-types"]),
        ft: isTrue(sec?.ft ?? conf["security.ft"]),
        network: networkOfConf(conf),
        configs: [],
        aps: [],
        clients: 0,
        country: conf.country,
        hidden: isTrue(conf["hide-ssid"]),
        security: conf.security,
      };
      ssids.set(conf.ssid, s);
    }
    if (band && !s.bands.includes(band)) s.bands.push(band);
    if (!s.configs.includes(conf.name ?? "")) s.configs.push(conf.name ?? "");
    return { ssid: s, conf, band, chan: ch };
  };

  // Configurations referenced from provisioning rules also exist on future CAPs.
  for (const p of menu(cfg, "/interface/wifi/provisioning")) {
    ssidFor(p["master-configuration"]);
    for (const sc of list(p["slave-configurations"])) ssidFor(sc);
  }

  const masters = wifiIfaces.filter((w) => !w["master-interface"]);
  for (const w of masters) {
    // REST names the CAP as `identity@base-mac%iface`; an export prints it in a comment instead.
    const capMac = normMac(w.cap?.match(/@([0-9A-F:]{17})/i)?.[1] ?? w._notes?.match(/CAP ([0-9A-F:]{17})/i)?.[1]);
    const apId = capMac ? `mac:${capMac}` : routerId ?? "router";
    const s = ssidFor(w.configuration);
    const slaves = wifiIfaces.filter((x) => x["master-interface"] === w.name);
    const slaveSsids = slaves.map((x) => ssidFor(x.configuration)).filter(Boolean);
    const live = wifiState.find((x) => x.name === w.name);
    const capSnap = capMac ? caps.get(capMac)?.snap : undefined;
    // A CAP's own export prints the current channel above its radios.
    const capNote = capSnap
      ? menu(capSnap.config, "/interface/wifi").find((x) => (x._notes ?? "").includes("channel:") && guessBandFromNote(x._notes) === s?.band)?._notes
      : undefined;
    const current = parseChannelStatus(live?.channel ?? capNote?.match(/channel:\s*(\S+)/)?.[1]);
    // What the router says about this radio first (REST puts the channel band on the interface).
    const band = bandFromRos(w["channel.band"]) ?? current?.band ?? s?.band ?? "5";
    const radio: Radio = {
      id: w.name ?? "",
      apId,
      iface: w.name ?? "",
      band,
      ssids: [s?.ssid.name, ...slaveSsids.map((x) => x!.ssid.name)].filter((x): x is string => !!x),
      plan: s?.chan
        ? { frequencies: list(s.chan.frequency).map(Number).filter(Boolean), width: s.chan.width, skipDfs: s.chan["skip-dfs-channels"] === "all" || s.chan["skip-dfs-channels"] === "10min-cac" }
        : undefined,
      current: current ? { freq: current.freq, channel: current.channel, width: current.width, dfs: current.dfs } : undefined,
      clients: 0,
    };
    radios.push(radio);
    for (const x of [s, ...slaveSsids]) {
      if (!x) continue;
      if (!x.ssid.aps.includes(apId)) x.ssid.aps.push(apId);
      // An SSID is on every band of the radios that carry it, whatever its configuration is called.
      if (!x.ssid.bands.includes(band)) x.ssid.bands.push(band);
    }
  }
  for (const s of ssids.values()) if (s.network) networks.find((n) => n.id === s.network)?.ssids.push(s.name);

  // ---- clients ------------------------------------------------------------------
  const regs = stateMenu("/interface/wifi/registration-table");
  const hosts = stateMenu("/interface/bridge/host").filter((h) => !isTrue(h.local));
  // The WAN gateway is the upstream device, not a client, however the router saw it.
  const arp = stateMenu("/ip/arp").filter((a) => !gwMac || normMac(a["mac-address"]) !== gwMac);
  const upstreamSide = (iface?: string) => zoneOfIface(iface) === "upstream";
  const routerMacs = new Set(menu(cfg, "/interface/bridge").map((b) => normMac(b["admin-mac"])).filter(Boolean));
  const macs = new Set<string>();
  for (const l of leasesCfg) macs.add(normMac(l["mac-address"]));
  for (const l of leasesState) macs.add(normMac(l["mac-address"]));
  for (const r of regs) macs.add(normMac(r["mac-address"]));
  for (const h of hosts) macs.add(normMac(h["mac-address"]));
  for (const a of arp) if (a["mac-address"]) macs.add(normMac(a["mac-address"]));
  for (const k of Object.keys(ov.devices ?? {})) macs.add(normMac(k));
  macs.delete("");
  if (gwMac) macs.delete(gwMac);

  const radioOfIface = (iface?: string) => {
    if (!iface) return undefined;
    const w = wifiIfaces.find((x) => x.name === iface);
    const master = w?.["master-interface"] ? w["master-interface"] : iface;
    return radios.find((r) => r.iface === master);
  };
  const apPorts = new Map<string, string>(); // router port -> AP id
  for (const id of apIds) {
    const mac = id.slice(4);
    const h = hosts.find((x) => normMac(x["mac-address"]) === mac);
    if (h?.["on-interface"]) apPorts.set(h["on-interface"], id);
  }

  for (const mac of macs) {
    if (routerMacs.has(mac) || caps.has(mac)) continue;
    const ovd = ov.devices?.[mac] ?? ov.devices?.[mac.toLowerCase()];
    const lc = leasesCfg.find((l) => normMac(l["mac-address"]) === mac);
    const ls = leasesState.find((l) => normMac(l["mac-address"]) === mac);
    const reg = regs.find((r) => normMac(r["mac-address"]) === mac);
    const host = hosts.find((h) => normMac(h["mac-address"]) === mac);
    // A device can have ARP entries on both sides (an old address on the upstream network).
    // Anything this router serves on the LAN side wins; the upstream entry is then only a fact.
    const arps = arp.filter((x) => normMac(x["mac-address"]) === mac);
    const lanArp = arps.find((x) => !upstreamSide(x.interface));
    const upArp = arps.find((x) => upstreamSide(x.interface));
    const onLan = !!(lc || ls || reg || lanArp || (host && !upstreamSide(host["on-interface"])));
    const a = lanArp ?? (onLan ? undefined : upArp);
    const v = vendorOf(mac);
    const hostname = ls?.["host-name"];
    const comment = lc?.comment ?? ls?.comment;
    // Prefer where the device actually is now: a bound lease, then ARP, then its reservation.
    const currentIp = (ls && (ls.status === "bound" || !ls.status) ? ls.address : undefined) ?? a?.address;
    const ip = currentIp ?? lc?.address;

    let kind: DeviceKind | undefined = (ovd?.kind as DeviceKind | undefined) ?? undefined;
    let kindCertainty: Certainty = kind ? "user" : "inferred";
    kind ??= kindFromText(comment ? shortName(comment) : undefined) ?? kindFromText(hostname) ?? kindFromText(comment) ?? v.kind ?? (v.private && reg ? "phone" : undefined);
    if (!kind) {
      kind = "unknown";
      kindCertainty = "inferred";
    }

    let name = ovd?.name;
    let nameSource: Device["nameSource"] = "user";
    if (!name && comment) [name, nameSource] = [shortName(comment), "comment"];
    if (!name && hostname) [name, nameSource] = [hostname, "hostname"];
    if (!name && v.vendor) [name, nameSource] = [`${v.vendor} ${mac.slice(-5)}`, "vendor"];
    if (!name) [name, nameSource] = [`${v.private ? "Private" : KIND_LABEL[kind]} ${mac.slice(-5)}`, "mac"];

    const d: Device = {
      id: `mac:${mac}`,
      kind,
      kindCertainty,
      name,
      nameSource,
      mac,
      ip,
      hostname,
      vendor: v.vendor,
      privateMac: v.private,
      reserved: !!lc,
      leaseComment: comment,
      network: networkOfIp(ip) ?? (host?.bridge ? networks.find((n) => n.bridge === host.bridge)?.id : undefined),
      zone: "lan",
      status: "unknown",
      ...noteFields(ovd),
      lastSeen: ls?.["last-seen"],
      facts: [],
    };
    if (!onLan && (upArp || host)) d.zone = "upstream";
    else if (d.network && networks.find((n) => n.id === d.network)?.role === "wan") d.zone = "upstream";
    else if (ip && !lanNet?.cidr) d.zone = "lan";
    else if (ip && lanNet?.cidr && !inCidr(ip, lanNet.cidr) && d.network === undefined) d.zone = "upstream";
    if (comment) d.facts.push(`DHCP reservation note: “${comment}”`);
    if (onLan && upArp?.address) d.facts.push(`Also known on the upstream network as ${upArp.address} (${arpWords(upArp)})`);
    if (!onLan && upArp) d.facts.push(`Seen only on the upstream network, in the router's address table: ${arpWords(upArp)}`);
    if (lc?.address && currentIp && currentIp !== lc.address) d.facts.push(`Reserved ${lc.address}, but currently at ${currentIp}`);

    if (reg) {
      const radio = radioOfIface(reg.interface);
      const ssidName = reg.ssid ?? radio?.ssids[0];
      d.parent = radio?.apId;
      d.via = {
        kind: "wifi",
        ssid: ssidName,
        band: bandFromRos(reg.band) ?? radio?.band,
        signal: parseSignal(reg.signal ?? reg["signal-strength"]),
        txRate: wifiRate(reg["tx-rate"]),
        rxRate: wifiRate(reg["rx-rate"]),
        // The access point transmits towards the client.
        downBps: bps(reg["tx-bits-per-second"]),
        upBps: bps(reg["rx-bits-per-second"]),
        radio: radio?.id,
        certainty: "read",
      };
      d.status = "online";
      if (radio) radio.clients++;
      const s = ssidName ? ssids.get(ssidName) : undefined;
      if (s) s.clients++;
    } else if (host) {
      const iface = host["on-interface"] ?? "";
      const behindAp = apPorts.get(iface);
      if (behindAp) {
        d.parent = behindAp;
        d.via = { kind: "port", port: guessApPort(comment), certainty: "inferred" };
      } else {
        d.parent = routerId;
        d.via = { kind: "port", port: iface, certainty: "read" };
      }
      d.status = "online";
    } else if (!hasState && lc) {
      // Config only: try the port comment ("Home LAN: NAS 192.168.88.10").
      const p = ports.find((x) => x.comment && commentMatches(x.comment, d));
      if (p) {
        d.parent = routerId;
        d.via = { kind: "port", port: p.name, certainty: "inferred" };
      }
    }
    if (hasState && d.status === "unknown") {
      // A live router reports ARP reachability; a valid lease alone only means the address is still reserved for it.
      const arpUp = a?.status ? /reachable|delay|probe|permanent/.test(a.status) : a?.complete === "true";
      d.status = arpUp || (!a?.status && ls?.status === "bound") ? "online" : "offline";
      if (d.status === "offline" && ls?.status === "bound")
        d.facts.push(`Probably asleep or gone: its address lease is still valid, but it has not answered recently${ls["last-seen"] ? ` (last DHCP contact ${ls["last-seen"]} ago)` : ""}`);
    }
    if (d.zone === "upstream") d.parent ??= devices.has("upstream") ? "upstream" : routerId;
    d.only24 = ovd?.only24 ?? likelyOnly24(kind, comment, hostname, name);
    add(d);
  }

  // AP placement: on the router port where its MAC is learned, or from its lease/port comment.
  for (const id of apIds) {
    const ap = devices.get(id)!;
    const port = [...apPorts.entries()].find(([, v]) => v === id)?.[0] ?? ports.find((p) => p.comment && /w?ap|access point/i.test(p.comment) && p.zone === "lan")?.name;
    ap.parent = routerId;
    ap.via = { kind: "port", port, certainty: apPorts.size ? "read" : "inferred" };
    const p = portByName(port);
    if (p?.poeWatts) ap.facts.push(`Powered over PoE from ${p.name}: ${p.poeVolts ?? "?"} V, ${p.poeWatts} W`);
  }

  // The router port the WAN goes out of: the WAN interface itself, or the port of the WAN bridge
  // where the gateway's MAC is learned, else the one with a link, else the first.
  const wanPorts = wan.iface ? (portByName(wan.iface) ? [wan.iface] : bridgePorts.filter((p) => p.bridge === wan.iface).map((p) => p.interface ?? "")) : [];
  const gwHost = gwMac ? hosts.find((h) => normMac(h["mac-address"]) === gwMac && wanPorts.includes(h["on-interface"] ?? "")) : undefined;
  const upstreamPortName = gwHost?.["on-interface"] ?? wanPorts.find((n) => portByName(n)?.running) ?? wanPorts.find((n) => portByName(n));

  // Devices on the upstream side: on a WAN-side router port other than the uplink they hang off
  // the router; otherwise they are somewhere on the ISP router's network.
  for (const d of devices.values()) {
    if (d.zone !== "upstream" || d.id === "upstream") continue;
    const host = hosts.find((h) => normMac(h["mac-address"]) === d.mac);
    if (host?.["on-interface"] && host["on-interface"] !== upstreamPortName && portByName(host["on-interface"])?.zone === "upstream") {
      d.parent = routerId;
      d.via = { kind: "port", port: host["on-interface"], certainty: "read" };
    } else {
      d.parent = "upstream";
      d.via = { kind: "upstream", certainty: "inferred" };
    }
  }

  // Port occupancy.
  for (const d of devices.values()) {
    if (d.parent === routerId && d.via?.kind === "port" && d.via.port) portByName(d.via.port)?.deviceIds.push(d.id);
  }
  const upstreamPort = portByName(upstreamPortName);
  if (upstreamPort && devices.has("upstream")) upstreamPort.deviceIds.unshift("upstream");
  if (routerId && devices.get(routerId)?.via && upstreamPort) devices.get(routerId)!.via!.port = upstreamPort.name;
  for (const pd of ov.planned ?? []) {
    const p = portByName(pd.port);
    if (p) p.planned = pd.id;
  }

  const sources = snap.devices.flatMap((d) => d.sources);
  return {
    site: ov.site ?? lanNet?.label ?? "Home",
    timezone: single(cfg, "/system/clock")?.["time-zone-name"],
    generatedAt: snap.collectedAt,
    sources,
    hasState,
    sampleState: !!snap.sampleState,
    routerId,
    devices: [...devices.values()],
    ports,
    networks,
    ssids: [...ssids.values()],
    radios,
    wan,
    planned: ov.planned ?? [],
    services: servicesOf(cfg),
    // Dynamic rules (the live fasttrack counter, UPnP) are not part of the configuration.
    firewall: cfg
      ? { filter: menu(cfg, "/ip/firewall/filter").filter((r) => !isTrue(r.dynamic)).map(fwRule), nat: menu(cfg, "/ip/firewall/nat").filter((r) => !isTrue(r.dynamic)).map(fwRule) }
      : undefined,
  };
}

// ---------------------------------------------------------------------------

function isLegacyAlias(a: RosRecord): boolean {
  return /\/32$/.test(a.address ?? "") || (!!a.network && a.address?.split("/")[0] === a.network && !(a.address ?? "").includes("/"));
}

function guessRole(name: string, comment?: string): NetworkRole {
  const t = `${name} ${comment ?? ""}`;
  if (/guest|gost/i.test(t)) return "guest";
  if (/iot|smart/i.test(t)) return "iot";
  if (/mgmt|management/i.test(t)) return "management";
  if (/legacy|old|temporary|temp/i.test(t)) return "legacy";
  return "lan";
}

function labelFor(name: string, comment: string | undefined, role: NetworkRole): string {
  if (role === "wan") return "Upstream";
  const c = comment?.replace(/\s*\d+\.\d+\.\d+\.\d+\/\d+\s*/, "").trim();
  if (c && c.length <= 24) return c;
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/** "48000000", "48Mbps", "1.2Gbps" → bits per second. */
function bps(v?: string): number | undefined {
  if (v === undefined || v === "") return undefined;
  const m = /^([\d.]+)\s*([kMG])?(?:bps)?$/i.exec(v.trim());
  if (!m) return undefined;
  const mult = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "g"] ?? 1;
  return Number(m[1]) * mult;
}

/** Wi-Fi rates as "866.7Mbps": exports print them that way, REST gives bits per second. */
function wifiRate(r?: string): string | undefined {
  if (!r || !/^\d+$/.test(r)) return r;
  return `${Math.round(Number(r) / 1e5) / 10}Mbps`;
}

/** An ARP entry's state in plain words. */
function arpWords(a: RosRecord): string {
  const st = a.status ?? (a.complete === "true" ? "complete" : "incomplete");
  if (/reachable|delay|probe|permanent/.test(st)) return "answering now";
  if (st === "stale") return "not heard from recently";
  return "not answering";
}

/** The descriptive parts of a device's notes, as they appear on the device. */
function noteFields(n: DeviceNotes | undefined): Pick<Device, "labels" | "description" | "services" | "notes"> {
  if (!n) return {};
  return {
    ...(n.labels?.length ? { labels: n.labels } : {}),
    ...(n.description ? { description: n.description } : {}),
    ...(n.services?.length ? { services: n.services } : {}),
    ...(n.notes ? { notes: n.notes } : {}),
  };
}

function guessBandFromNote(note?: string): Band | undefined {
  const f = Number(note?.match(/channel:\s*(\d+)/)?.[1]);
  return f ? (f < 3000 ? "2.4" : f < 5925 ? "5" : "6") : undefined;
}

function guessApPort(comment?: string): string | undefined {
  return comment?.match(/\b(ether\d+)\b/i)?.[1];
}

function commentMatches(portComment: string, d: Device): boolean {
  if (d.ip && portComment.includes(d.ip)) return true;
  const words = (d.leaseComment ?? d.name).split(/\s+/).filter((w) => w.length >= 5);
  return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(portComment));
}
