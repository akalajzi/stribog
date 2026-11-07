// Small changes to a router that is already set up, as a script to review, with its undo.
//
// changeContext() reads what a change needs from the router's configuration: the LAN bridge and
// whether it filters VLANs, the WAN, the firewall chains, the Wi-Fi configurations and radios.
// generateChange() turns a few choices (add a guest or IoT network, rename the Wi-Fi, change its
// security or 5 GHz channels) into only the commands for those changes, and a script that takes
// them back. Everything it adds carries a "Stribog <network>" comment, so the undo finds it again.
// Pure and deterministic. Secrets are never part of the output; new Wi-Fi starts disabled until
// its passphrase is set on the router. Stribog never applies either script.

import { bandFromRos, inCidr, intToIp, parseCidr, type Band } from "./net.ts";
import type { NetworkModel } from "./model.ts";
import { enabled, isTrue, list, menu, type RosRecord, type Snapshot } from "./ros.ts";
import { net, poolIn, rosQuote } from "./setup.ts";

export type SideKind = "guest" | "iot";
export type WifiSecurity = "wpa2" | "wpa2-wpa3" | "wpa3" | "other";

export interface ExistingNetwork {
  iface: string;
  vlan?: number;
  cidr?: string;
  ssids: string[];
  /** True when the role comes from the name or comment rather than from the owner's notes. */
  inferred: boolean;
}

export interface ChangeContext {
  site: string;
  /** Why Stribog cannot write changes for this router at all. */
  blocked?: string;
  bridge: string;
  vlanFiltering: boolean;
  lan?: string;
  /** Bridge ports with access points behind them (inferred from what is connected): they carry new VLANs. */
  apPorts: string[];
  wan: { list: boolean; iface?: string };
  /** A masquerade to the internet that applies to any source address. */
  natCoversAll: boolean;
  /** The router answers DNS for its clients (allow-remote-requests). */
  routerDns: boolean;
  dnsServers: string[];
  /** Chains with rules already: new rules go above them. */
  chains: { input: boolean; forward: boolean };
  /** The forward chain ends with a rule that drops everything not accepted before it. */
  forwardDropsRest: boolean;
  taken: { vlans: number[]; subnets: string[]; names: string[] };
  existing: Partial<Record<SideKind, ExistingNetwork>>;
  wifi?: WifiContext;
  /** Why Stribog cannot add or change Wi-Fi here. */
  wifiBlocked?: string;
  /** Access points with their own configuration read, and whether their bridge filters VLANs. */
  caps: { name: string; vlanFiltering: boolean }[];
  apCount: number;
  /** What Stribog read, in plain words. */
  read: { text: string; inferred?: boolean }[];
}

export interface WifiContext {
  country?: string;
  /** Radio interfaces a new Wi-Fi name can be added to (dynamic ones come from provisioning). */
  radios: { name: string; band?: Band }[];
  provisioning: { master: string; slaves: string[]; band?: Band; dynamic: boolean }[];
  /** True when two provisioning rules share a master configuration with different extra Wi-Fi. */
  provisioningAmbiguous: boolean;
  main?: {
    ssid: string;
    configs: string[];
    auth: string[];
    security: WifiSecurity;
    /** Named security profiles, and configurations with their own security settings. */
    secProfiles: string[];
    secInline: string[];
    /** Other Wi-Fi names that share those security profiles. */
    secShared: string[];
    /** 5 GHz channel settings: named profiles and configurations with their own. */
    ch5Profiles: string[];
    ch5Inline: string[];
    width5?: string;
    skipDfs?: string;
  };
}

export interface SideChoice {
  add: boolean;
  vlan: number;
  subnet: string;
  ssid: string;
  /** Guest: clients cannot see each other. */
  isolation: boolean;
  /** IoT: the LAN can open connections to it. */
  lanCanReach: boolean;
}

export interface ChangeOptions {
  guest: SideChoice;
  iot: SideChoice;
  wifi: { ssid: string; security: WifiSecurity; width5: string; allowDfs: boolean };
}

export interface ChangeResult {
  /** One line per change, for the page and the script header. Empty: nothing to change. */
  changes: string[];
  script: string;
  undo: string;
  notes: string[];
}

const LABEL: Record<SideKind, string> = { guest: "Guest", iot: "IoT" };
const AUTH: Record<Exclude<WifiSecurity, "other">, string> = { wpa2: "wpa2-psk", "wpa2-wpa3": "wpa2-psk,wpa3-psk", wpa3: "wpa3-psk" };
const SECURITY_LABEL: Record<WifiSecurity, string> = { wpa2: "WPA2", "wpa2-wpa3": "WPA2 + WPA3", wpa3: "WPA3 only", other: "as configured" };

export function securityOf(auth: string[]): WifiSecurity {
  const a = [...auth].sort().join(",");
  return a === "wpa2-psk" ? "wpa2" : a === "wpa2-psk,wpa3-psk" ? "wpa2-wpa3" : a === "wpa3-psk" ? "wpa3" : "other";
}

const tag = (k: SideKind) => `Stribog ${k === "iot" ? "IoT" : "guest"} network`;
const isDynamic = (r: RosRecord) => isTrue(r.dynamic);

function overlaps(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  return !!x && !!y && (inCidr(intToIp(x.network), b) || inCidr(intToIp(y.network), a));
}

// ---------------------------------------------------------------------------------------------
// Reading

export function changeContext(snap: Snapshot, model: NetworkModel): ChangeContext {
  const routerSnap = snap.devices.find((d) => d.role === "router");
  const cfg = routerSnap?.config;
  const read: ChangeContext["read"] = [];
  const lanNet = model.networks.find((n) => n.role === "lan" && !n.vlan && n.cidr) ?? model.networks.find((n) => n.role === "lan" && n.cidr);
  const bridgeRec = menu(cfg, "/interface/bridge").find((b) => b.name === lanNet?.bridge);
  const bridge = bridgeRec?.name ?? "";
  const vlanFiltering = isTrue(bridgeRec?.["vlan-filtering"]);

  const lists = menu(cfg, "/interface/list/member").filter(enabled);
  const wanList = lists.some((m) => m.list === "WAN");
  const wanIface = model.wan.type === "pppoe" ? menu(cfg, "/interface/pppoe-client").find(enabled)?.name ?? model.wan.iface : model.wan.iface;

  const filter = menu(cfg, "/ip/firewall/filter").filter((r) => enabled(r) && !isDynamic(r));
  const chainRules = (c: string) => filter.filter((r) => r.chain === c);
  const matchers = /^(in-|out-|src-|dst-|protocol|connection-|port|ipsec|packet-mark|routing-mark|layer7|content|hotspot|icmp|tcp-|limit|nth|time|psd|p2p|ttl|dscp|priority)/;
  const last = chainRules("forward").at(-1);
  const forwardDropsRest = !!last && last.action === "drop" && !Object.keys(last).some((k) => matchers.test(k));

  const masq = menu(cfg, "/ip/firewall/nat").filter((r) => enabled(r) && r.chain === "srcnat" && (r.action === "masquerade" || r.action === "src-nat"));
  const natCoversAll = masq.some((r) => !r["src-address"] && !r["src-address-list"] && (r["out-interface-list"] === "WAN" || (!!wanIface && r["out-interface"] === wanIface)));

  const dns = menu(cfg, "/ip/dns")[0];
  const routerDns = isTrue(dns?.["allow-remote-requests"]);

  const vlans = [...menu(cfg, "/interface/vlan").map((v) => Number(v["vlan-id"])), ...menu(cfg, "/interface/bridge/vlan").flatMap((v) => list(v["vlan-ids"]).flatMap(range))].filter(Boolean);
  const subnets = menu(cfg, "/ip/address").map((a) => a.address).filter((a): a is string => !!a).map((a) => {
    const c = parseCidr(a);
    return c ? `${intToIp(c.network)}/${c.prefix}` : a;
  });
  const names = [
    ...["/interface/bridge", "/interface/vlan", "/interface/wifi", "/interface/pppoe-client", "/ip/pool", "/ip/dhcp-server", "/interface/wifi/configuration", "/interface/wifi/security", "/interface/wifi/datapath", "/interface/wifi/channel"].flatMap((p) =>
      menu(cfg, p).map((r) => r.name ?? ""),
    ),
    ...menu(cfg, "/interface/ethernet").flatMap((e) => [e.name ?? "", e["default-name"] ?? ""]),
  ].filter(Boolean);

  const userRoles = snap.notes?.networks ?? {};
  const existing: ChangeContext["existing"] = {};
  for (const k of ["guest", "iot"] as SideKind[]) {
    const n = model.networks.find((x) => x.role === k);
    if (n) existing[k] = { iface: n.name, vlan: n.vlan, cidr: n.cidr, ssids: n.ssids, inferred: userRoles[n.name]?.role !== k };
  }

  const apIds = new Set(model.devices.filter((d) => d.kind === "ap").map((d) => d.id));
  const apPorts = model.ports.filter((p) => p.bridge === bridge && p.deviceIds.some((id) => apIds.has(id))).map((p) => p.name);
  const caps = snap.devices
    .filter((d) => d.role === "cap")
    .map((d) => ({ name: menu(d.config, "/system/identity")[0]?.name ?? d.sources[0]?.label ?? "access point", vlanFiltering: menu(d.config, "/interface/bridge").some((b) => isTrue(b["vlan-filtering"])) }));

  // ---- Wi-Fi ----
  let wifi: WifiContext | undefined;
  let wifiBlocked: string | undefined;
  const confs = menu(cfg, "/interface/wifi/configuration");
  const ifaces = menu(cfg, "/interface/wifi");
  if (!confs.length && !ifaces.length) wifiBlocked = "No Wi-Fi from RouterOS's wifi package was read on the router (it may use the older wireless package, or have no Wi-Fi).";
  else {
    const secs = menu(cfg, "/interface/wifi/security");
    const chans = menu(cfg, "/interface/wifi/channel");
    const radioBand = new Map(model.radios.map((r) => [r.iface, r.band]));
    const confBand = (name?: string): Band | undefined => {
      const c = confs.find((x) => x.name === name);
      if (!c) return undefined;
      const ch = chans.find((x) => x.name === c.channel);
      return (
        bandFromRos(ch?.band ?? c["channel.band"]) ??
        ifaces.filter((w) => w.configuration === name).map((w) => radioBand.get(w.name ?? "")).find(Boolean) ??
        (/(2g|2ghz|24)/i.test(name ?? "") ? "2.4" : /(5g|5ghz)/i.test(name ?? "") ? "5" : undefined)
      );
    };
    const provisioning = menu(cfg, "/interface/wifi/provisioning")
      .filter(enabled)
      .map((p) => ({
        master: p["master-configuration"] ?? "",
        slaves: list(p["slave-configurations"]),
        band: /2ghz/.test(p["supported-bands"] ?? "") ? ("2.4" as Band) : /5ghz/.test(p["supported-bands"] ?? "") ? ("5" as Band) : confBand(p["master-configuration"]),
        dynamic: /dynamic/.test(p.action ?? "create-dynamic-enabled"),
      }))
      .filter((p) => p.master);
    const provisioningAmbiguous = provisioning.some((p, i) => provisioning.some((q, j) => j !== i && q.master === p.master && q.slaves.join() !== p.slaves.join()));
    const radios = ifaces.filter((w) => !w["master-interface"] && !isDynamic(w) && w.name).map((w) => ({ name: w.name!, band: radioBand.get(w.name!) ?? confBand(w.configuration) }));

    // The main Wi-Fi: the LAN's name on the most access points.
    const mainSsid = model.ssids.filter((s) => s.network === lanNet?.id).sort((a, b) => b.aps.length - a.aps.length || b.configs.length - a.configs.length)[0];
    let main: WifiContext["main"];
    if (mainSsid) {
      const mc = confs.filter((c) => c.ssid === mainSsid.name && c.name);
      const secProfiles = [...new Set(mc.map((c) => c.security).filter((s): s is string => !!s && secs.some((x) => x.name === s)))];
      const secInline = mc.filter((c) => !c.security || !secs.some((x) => x.name === c.security)).filter((c) => c["security.authentication-types"] !== undefined).map((c) => c.name!);
      const secShared = [...new Set(confs.filter((c) => c.ssid !== mainSsid.name && c.security && secProfiles.includes(c.security)).map((c) => c.ssid!).filter(Boolean))];
      const auth = list(secs.find((x) => x.name === secProfiles[0])?.["authentication-types"] ?? mc.find((c) => c["security.authentication-types"])?.["security.authentication-types"]);
      const mc5 = mc.filter((c) => confBand(c.name) === "5");
      const ch5Profiles = [...new Set(mc5.map((c) => c.channel).filter((s): s is string => !!s && chans.some((x) => x.name === s)))];
      const ch5Inline = mc5.filter((c) => !c.channel && (c["channel.width"] !== undefined || c["channel.skip-dfs-channels"] !== undefined || c["channel.band"] !== undefined)).map((c) => c.name!);
      const ch = chans.find((x) => x.name === ch5Profiles[0]);
      const inl = mc5.find((c) => c.name === ch5Inline[0]);
      main = {
        ssid: mainSsid.name,
        configs: mc.map((c) => c.name!),
        auth,
        security: securityOf(auth),
        secProfiles,
        secInline,
        secShared,
        ch5Profiles,
        ch5Inline,
        width5: ch?.width ?? inl?.["channel.width"],
        skipDfs: ch?.["skip-dfs-channels"] ?? inl?.["channel.skip-dfs-channels"],
      };
    }
    wifi = { country: confs.find((c) => c.ssid === mainSsid?.name && c.country)?.country ?? confs.find((c) => c.country)?.country, radios, provisioning, provisioningAmbiguous, main };
    if (!radios.length && !provisioning.length) wifiBlocked = "No Wi-Fi radio or provisioning rule was read that a new Wi-Fi name could be added to.";
  }

  // ---- what was read, in words ----
  if (lanNet) read.push({ text: `Home network ${lanNet.cidr ?? ""} on the bridge "${bridge}", VLAN filtering ${vlanFiltering ? "on" : "off"}` });
  if (wanIface) read.push({ text: `Internet through ${wanIface}${wanList ? " (interface list WAN)" : ""}` });
  read.push({ text: `Firewall: ${chainRules("input").length} rules for the router itself, ${chainRules("forward").length} for traffic through it${natCoversAll ? "; one masquerade for everything going out" : ""}` });
  if (wifi) {
    const dyn = wifi.provisioning.filter((p) => p.dynamic).length;
    read.push({ text: `Wi-Fi: ${wifi.radios.length} radio${wifi.radios.length === 1 ? "" : "s"}${wifi.provisioning.length ? `, ${wifi.provisioning.length} CAPsMAN provisioning rule${wifi.provisioning.length === 1 ? "" : "s"}${dyn ? " (access points get their Wi-Fi when provisioned)" : ""}` : ""}` });
  }
  if (apPorts.length) read.push({ text: `Access points behind ${apPorts.join(", ")}, from what is connected there`, inferred: true });
  for (const k of ["guest", "iot"] as SideKind[]) {
    const e = existing[k];
    if (e) read.push({ text: `${LABEL[k]} network already there: ${e.iface}${e.cidr ? ` (${e.cidr})` : ""}${e.inferred ? ", recognised by its name" : ""}`, inferred: e.inferred });
  }

  const blocked = !cfg
    ? "Stribog has no configuration from the router."
    : !lanNet || !bridge
      ? "Stribog could not find the home network's bridge, which new networks are added to."
      : !wanIface
        ? "Stribog could not tell which interface leads to the internet, which the firewall rules for new networks depend on."
        : undefined;

  return {
    site: model.site,
    blocked,
    bridge,
    vlanFiltering,
    lan: lanNet?.cidr,
    apPorts,
    wan: { list: wanList, iface: wanIface },
    natCoversAll,
    routerDns,
    dnsServers: list(dns?.servers),
    chains: { input: chainRules("input").length > 0, forward: chainRules("forward").length > 0 },
    forwardDropsRest,
    taken: { vlans: [...new Set(vlans)], subnets: [...new Set(subnets)], names: [...new Set(names)] },
    existing,
    wifi,
    wifiBlocked,
    caps,
    apCount: apIds.size,
    read,
  };
}

/** "20" or "20-23" as numbers. */
function range(v: string): number[] {
  const [a, b] = v.split("-").map(Number);
  if (!a) return [];
  if (!b || b < a || b - a > 4094) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

// ---------------------------------------------------------------------------------------------
// Choosing

/** A VLAN id and a subnet nothing on the router uses yet. */
function freeSide(ctx: ChangeContext, preferred: number, avoid: number[] = []): { vlan: number; subnet: string } {
  const used = new Set([...ctx.taken.vlans, ...avoid]);
  let vlan = preferred;
  while (used.has(vlan) && vlan < 4094) vlan += 10;
  const cands = [`192.168.${vlan % 256}.0/24`, `10.${vlan % 256}.0.0/24`, `172.16.${vlan % 256}.0/24`];
  const subnet = cands.find((c) => !ctx.taken.subnets.some((s) => overlaps(s, c))) ?? cands[0]!;
  return { vlan, subnet };
}

/** Starting point: nothing changes until something is chosen. */
export function defaultChangeOptions(ctx: ChangeContext): ChangeOptions {
  const g = freeSide(ctx, 20);
  // The IoT network keeps clear of the guest one only when that is new too.
  const i = ctx.existing.guest ? freeSide(ctx, 30) : freeSide({ ...ctx, taken: { ...ctx.taken, subnets: [...ctx.taken.subnets, g.subnet] } }, 30, [g.vlan]);
  const base = ctx.wifi?.main?.ssid ?? ctx.site;
  const m = ctx.wifi?.main;
  return {
    guest: { add: false, ...g, ssid: `${base}-Guest`, isolation: true, lanCanReach: false },
    iot: { add: false, ...i, ssid: `${base}-IoT`, isolation: false, lanCanReach: true },
    wifi: { ssid: m?.ssid ?? "", security: m?.security ?? "other", width5: m?.width5 ?? "", allowDfs: dfsAllowed(m?.skipDfs) },
  };
}

const dfsAllowed = (skip?: string) => !skip || skip === "disabled" || skip === "10min-cac";

// ---------------------------------------------------------------------------------------------
// Writing

export function generateChange(ctx: ChangeContext, o: ChangeOptions): ChangeResult {
  const notes: string[] = [];
  const changes: string[] = [];
  const S: string[] = [];
  const U: string[] = [];
  if (ctx.blocked) return { changes, script: "", undo: "", notes: [ctx.blocked] };
  const section = (out: string[], title: string) => out.push("", `# ---- ${title} ${"-".repeat(Math.max(4, 64 - title.length))}`);
  const names = new Set(ctx.taken.names);
  const free = (n: string) => {
    let x = n;
    for (let i = 2; names.has(x); i++) x = `${n}-${i}`;
    names.add(x);
    return x;
  };
  const toWan = ctx.wan.list ? "out-interface-list=WAN" : `out-interface=${ctx.wan.iface}`;
  const notToWan = ctx.wan.list ? "out-interface-list=!WAN" : `out-interface=!${ctx.wan.iface}`;
  const fromNotWan = ctx.wan.list ? "in-interface-list=!WAN" : `in-interface=!${ctx.wan.iface}`;

  // ---- new networks ----
  const undoSides: string[][] = [];
  const usedVlans: number[] = [];
  const usedSubnets: string[] = [];
  for (const k of ["guest", "iot"] as SideKind[]) {
    const c = o[k];
    if (!c.add || ctx.existing[k]) continue;
    const label = LABEL[k];
    const t = tag(k);
    const n = net(c.subnet);
    if (!n) {
      notes.push(`"${c.subnet}" is not a usable ${label} subnet (use a /16 to /30); the ${label} network is left out.`);
      continue;
    }
    if (!Number.isInteger(c.vlan) || c.vlan < 2 || c.vlan > 4094 || ctx.taken.vlans.includes(c.vlan) || usedVlans.includes(c.vlan)) {
      notes.push(`VLAN ${c.vlan} is ${ctx.taken.vlans.includes(c.vlan) || usedVlans.includes(c.vlan) ? "already in use" : "not valid (2–4094)"}; the ${label} network is left out until it has a free one.`);
      continue;
    }
    const clash = [...ctx.taken.subnets, ...usedSubnets].find((s) => overlaps(s, n.cidr));
    if (clash) {
      notes.push(`${n.cidr} overlaps ${clash}, which the router already uses; the ${label} network is left out until it has its own subnet.`);
      continue;
    }
    usedVlans.push(c.vlan);
    usedSubnets.push(n.cidr);
    const iface = free(`vlan${c.vlan}-${k}`);
    const pool = free(`pool-${k}`);
    const dhcp = free(`dhcp-${k}`);
    const range = poolIn(n, undefined, notes, label);
    const dnsFor = ctx.routerDns ? n.gw : (ctx.dnsServers.length ? ctx.dnsServers : ["1.1.1.1", "9.9.9.9"]).join(",");
    if (!ctx.routerDns) notes.push(`The router does not answer DNS for its clients (allow-remote-requests is off), so ${label} clients get ${dnsFor} directly.`);
    const trunk = [ctx.bridge, ...ctx.apPorts].join(",");
    const ssid = c.ssid.trim();
    changes.push(`Add ${k === "iot" ? "an" : "a"} ${label} network: VLAN ${c.vlan}, ${n.cidr}${ssid && ctx.wifi && !ctx.wifiBlocked ? `, Wi-Fi "${ssid}"` : ""}`);

    section(S, `${label} network: VLAN ${c.vlan}, ${n.cidr}`);
    S.push(
      "/interface vlan",
      `add name=${iface} interface=${ctx.bridge} vlan-id=${c.vlan} comment=${rosQuote(t)}`,
    );
    if (ctx.vlanFiltering) {
      S.push("/interface bridge vlan", `add bridge=${ctx.bridge} vlan-ids=${c.vlan} tagged=${trunk} comment=${rosQuote(t)}`);
      if (!ctx.apPorts.length && ctx.apCount) notes.push(`Stribog could not tell which ports lead to the access points, so VLAN ${c.vlan} is tagged only towards the router. Add those ports to "tagged=" on the line for VLAN ${c.vlan} in /interface bridge vlan.`);
    } else
      notes.push(`VLAN filtering is off on the bridge "${ctx.bridge}", so the ${label} VLAN reaches every port and a wired device that tags its traffic could join it. Stribog does not turn filtering on here: done wrong, it cuts off your own connection to the router.`);
    S.push(
      "/ip address",
      `add address=${n.gw}/${n.prefix} interface=${iface} comment=${rosQuote(t)}`,
      "/ip pool",
      `add name=${pool} ranges=${range} comment=${rosQuote(t)}`,
      "/ip dhcp-server",
      `add name=${dhcp} interface=${iface} address-pool=${pool} lease-time=${k === "guest" ? "1h" : "1d"} disabled=no comment=${rosQuote(t)}`,
      "/ip dhcp-server network",
      `add address=${n.cidr} gateway=${n.gw} dns-server=${dnsFor} comment=${rosQuote(t)}`,
    );

    // Firewall: at the top of each chain, so the rules hold whatever comes after them.
    section(S, `${label} network: firewall`);
    const input = [
      `chain=input action=accept in-interface=${iface} protocol=udp dst-port=53,67 comment=${rosQuote(`${t}: DNS and DHCP from the router`)}`,
      `chain=input action=accept in-interface=${iface} protocol=tcp dst-port=53 comment=${rosQuote(`${t}: DNS over TCP`)}`,
      `chain=input action=drop in-interface=${iface} comment=${rosQuote(`${t}: nothing else on the router`)}`,
    ];
    const forward =
      k === "guest"
        ? [
            `chain=forward action=drop in-interface=${iface} ${notToWan} comment=${rosQuote(`${t}: internet only`)}`,
            `chain=forward action=drop out-interface=${iface} ${fromNotWan} comment=${rosQuote(`${t}: nothing else may reach it`)}`,
          ]
        : [
            `chain=forward action=drop in-interface=${iface} ${notToWan} connection-state=new comment=${rosQuote(`${t}: cannot start connections to other networks`)}`,
            ...(c.lanCanReach ? [] : [`chain=forward action=drop out-interface=${iface} ${fromNotWan} connection-state=new comment=${rosQuote(`${t}: the LAN cannot reach it either`)}`]),
          ];
    if (ctx.forwardDropsRest) forward.push(`chain=forward action=accept in-interface=${iface} ${toWan} comment=${rosQuote(`${t}: to the internet`)}`);
    S.push(
      `# ${k === "guest" ? "Guests get DNS and DHCP from the router, nothing else on it, and only the internet." : `${label} devices get DNS and DHCP from the router, and cannot start connections to other networks${c.lanCanReach ? "; the LAN can still reach them (casting, printing, camera apps)" : " or be reached from them"}.`}`,
      "# Each rule goes above the first rule already in its chain, in this order.",
      "{",
      ...(ctx.chains.input ? [`  :local inTop [/ip firewall filter find where chain="input" && dynamic=no]`] : []),
      ...(ctx.chains.forward ? [`  :local fwTop [/ip firewall filter find where chain="forward" && dynamic=no]`] : []),
      ...input.map((r) => `  /ip firewall filter add ${r}${ctx.chains.input ? " place-before=($inTop->0)" : ""}`),
      ...forward.map((r) => `  /ip firewall filter add ${r}${ctx.chains.forward ? " place-before=($fwTop->0)" : ""}`),
      "}",
    );
    if (!ctx.natCoversAll) S.push("/ip firewall nat", `add chain=srcnat action=masquerade src-address=${n.cidr} ${toWan} comment=${rosQuote(t)}`);

    // Wi-Fi for it.
    const wifi = ctx.wifi;
    const undoWifi: string[] = [];
    if (ssid && wifi && !ctx.wifiBlocked) {
      const bands: Band[] = k === "iot" ? ["2.4"] : ["2.4", "5", "6"];
      const onBand = (b?: Band) => !b || bands.includes(b);
      const sec = free(`sec-${k}`);
      const dp = free(`dp-${k}`);
      const cfg = free(`cfg-${k}`);
      const auth = k === "iot" ? "wpa2-psk" : AUTH[wifi.main?.security && wifi.main.security !== "other" ? wifi.main.security : "wpa2-wpa3"];
      section(S, `${label} network: Wi-Fi "${ssid}"`);
      S.push(
        "# No passphrase here: the new Wi-Fi starts disabled; set its passphrase on the router, then enable it (see the notes).",
        "/interface wifi security",
        `add name=${sec} authentication-types=${auth} comment=${rosQuote(t)}`,
        "/interface wifi datapath",
        `add name=${dp} bridge=${ctx.bridge} vlan-id=${c.vlan}${k === "guest" && c.isolation ? " client-isolation=yes" : ""} comment=${rosQuote(t)}`,
        "/interface wifi configuration",
        `add name=${cfg} ssid=${rosQuote(ssid)}${wifi.country ? ` country=${rosQuote(wifi.country)}` : ""} security=${sec} datapath=${dp} mode=ap comment=${rosQuote(t)}`,
      );
      const radios = wifi.radios.filter((r) => onBand(r.band));
      if (radios.length) S.push("/interface wifi", ...radios.map((r) => `add master-interface=${r.name} configuration=${cfg} name=${free(`${r.name}-${k}`)} disabled=yes comment=${rosQuote(t)}`));
      const prov = wifi.provisioning.filter((p) => onBand(p.band));
      if (prov.length && !wifi.provisioningAmbiguous) {
        const seen = new Set<string>();
        S.push("# Access points that are provisioned (now or later) get it too.", "/interface wifi provisioning");
        undoWifi.push("/interface wifi provisioning");
        for (const p of prov) {
          if (seen.has(p.master)) continue;
          seen.add(p.master);
          S.push(`set [find master-configuration=${rosQuote(p.master)}] slave-configurations=${[...p.slaves, cfg].join(",")}`);
          undoWifi.push(`set [find master-configuration=${rosQuote(p.master)}] slave-configurations=${p.slaves.length ? p.slaves.join(",") : '""'}`);
        }
        if (prov.some((p) => p.dynamic)) notes.push(`Access points that CAPsMAN set up dynamically show "${ssid}" after they are provisioned again (WinBox: Wi-Fi → Radios, select them, Provision). Set its passphrase first.`);
      } else if (prov.length) notes.push(`Two CAPsMAN provisioning rules share a configuration but carry different extra Wi-Fi, so Stribog does not change them. Add ${cfg} to "slave-configurations" of the rules that should carry "${ssid}".`);
      undoWifi.unshift(
        "/interface wifi",
        `remove [find where comment=${rosQuote(t)}]`,
        "/interface wifi configuration",
        `remove [find where comment=${rosQuote(t)}]`,
        "/interface wifi datapath",
        `remove [find where comment=${rosQuote(t)}]`,
        "/interface wifi security",
        `remove [find where comment=${rosQuote(t)}]`,
      );
      notes.push(
        `Set the passphrase for "${ssid}" and switch it on:  /interface wifi security set ${sec} passphrase="…"  then  /interface wifi enable [find where comment=${rosQuote(t)}]. The script never holds a passphrase.`,
      );
      if (k === "iot") notes.push(`"${ssid}" is on 2.4 GHz only and uses WPA2, which is what most smart plugs, cameras and TVs can join.`);
      const capsFiltering = ctx.caps.filter((x) => x.vlanFiltering);
      if (capsFiltering.length) notes.push(`${capsFiltering.map((x) => x.name).join(", ")} filter${capsFiltering.length === 1 ? "s" : ""} VLANs on ${capsFiltering.length === 1 ? "its" : "their"} own bridge: add VLAN ${c.vlan} to the uplink there (/interface bridge vlan), or Wi-Fi clients there get no address.`);
      else if (ctx.apCount && !ctx.caps.length) notes.push(`Each access point must pass VLAN ${c.vlan} on its uplink. If an access point's bridge filters VLANs, add VLAN ${c.vlan} there.`);
    } else if (ssid && ctx.wifiBlocked) notes.push(`The ${label} network has no Wi-Fi name in this script: ${ctx.wifiBlocked}`);

    undoSides.push([
      `# ${label} network`,
      ...undoWifi,
      "/ip firewall filter",
      `remove [find where comment~${rosQuote(`^${t}`)}]`,
      "/ip firewall nat",
      `remove [find where comment=${rosQuote(t)}]`,
      "/ip dhcp-server network",
      `remove [find where comment=${rosQuote(t)}]`,
      "/ip dhcp-server",
      `remove [find where comment=${rosQuote(t)}]`,
      "/ip pool",
      `remove [find where comment=${rosQuote(t)}]`,
      "/ip address",
      `remove [find where comment=${rosQuote(t)}]`,
      "/interface bridge vlan",
      `remove [find where comment=${rosQuote(t)}]`,
      "/interface vlan",
      `remove [find where comment=${rosQuote(t)}]`,
    ]);
  }

  // ---- the main Wi-Fi ----
  const m = ctx.wifi?.main;
  const undoWifiMain: string[] = [];
  if (m) {
    const w = o.wifi;
    const lines: string[] = [];
    const ssid = w.ssid.trim();
    if (ssid && ssid !== m.ssid) {
      changes.push(`Rename the Wi-Fi "${m.ssid}" to "${ssid}"`);
      lines.push("/interface wifi configuration", ...m.configs.map((c) => `set [find name=${rosQuote(c)}] ssid=${rosQuote(ssid)}`));
      undoWifiMain.push("/interface wifi configuration", ...m.configs.map((c) => `set [find name=${rosQuote(c)}] ssid=${rosQuote(m.ssid)}`));
      notes.push(`Every phone and laptop has to join "${ssid}" again, with the same passphrase. Devices that cannot be reached easily (smart plugs, cameras) will drop off until they do.`);
    }
    if (w.security !== "other" && w.security !== m.security) {
      if (!m.secProfiles.length && !m.secInline.length) notes.push(`Stribog could not find where "${m.ssid}" keeps its security settings, so its security is left as it is.`);
      else {
        const auth = AUTH[w.security];
        changes.push(`${m.ssid}: security ${SECURITY_LABEL[m.security]} → ${SECURITY_LABEL[w.security]}`);
        if (m.secProfiles.length) {
          lines.push("/interface wifi security", ...m.secProfiles.map((p) => `set [find name=${rosQuote(p)}] authentication-types=${auth}`));
          undoWifiMain.push("/interface wifi security", ...m.secProfiles.map((p) => `set [find name=${rosQuote(p)}] authentication-types=${m.auth.join(",") || '""'}`));
        }
        if (m.secInline.length) {
          lines.push("/interface wifi configuration", ...m.secInline.map((c) => `set [find name=${rosQuote(c)}] security.authentication-types=${auth}`));
          undoWifiMain.push("/interface wifi configuration", ...m.secInline.map((c) => `set [find name=${rosQuote(c)}] security.authentication-types=${m.auth.join(",") || '""'}`));
        }
        if (m.secShared.length) notes.push(`The security profile is shared with ${m.secShared.map((s) => `"${s}"`).join(", ")}, which change${m.secShared.length === 1 ? "s" : ""} too.`);
        if (w.security === "wpa3") notes.push("WPA3 only keeps out older phones, printers and TVs. Choose WPA2 + WPA3 if anything fails to join.");
        if (w.security === "wpa2") notes.push("WPA2 alone is what older devices need, but WPA2 + WPA3 lets newer ones use the stronger WPA3 at the same time.");
      }
    }
    const widthChanged = !!w.width5 && w.width5 !== (m.width5 ?? "");
    const dfsChanged = w.allowDfs !== dfsAllowed(m.skipDfs);
    if (widthChanged || dfsChanged) {
      if (!m.ch5Profiles.length && !m.ch5Inline.length) notes.push(`"${m.ssid}" has no 5 GHz channel settings Stribog can change (none are set on its configurations), so 5 GHz is left as it is.`);
      else {
        const skip = w.allowDfs ? "10min-cac" : "all";
        const set = [widthChanged ? `width=${w.width5}` : "", dfsChanged ? `skip-dfs-channels=${skip}` : ""].filter(Boolean);
        if (widthChanged) changes.push(`5 GHz width: ${m.width5 ?? "not set"} → ${w.width5}`);
        if (dfsChanged) changes.push(`5 GHz radar (DFS) channels: ${w.allowDfs ? "allowed" : "skipped"}`);
        const old = (prefix: string) => [
          widthChanged && m.width5 ? `${prefix}width=${m.width5}` : "",
          dfsChanged ? `${prefix}skip-dfs-channels=${m.skipDfs ?? "disabled"}` : "",
        ].filter(Boolean);
        if (m.ch5Profiles.length) {
          lines.push("/interface wifi channel", ...m.ch5Profiles.map((p) => `set [find name=${rosQuote(p)}] ${set.join(" ")}`));
          const back = old("");
          if (back.length) undoWifiMain.push("/interface wifi channel", ...m.ch5Profiles.map((p) => `set [find name=${rosQuote(p)}] ${back.join(" ")}`));
        }
        if (m.ch5Inline.length) {
          lines.push("/interface wifi configuration", ...m.ch5Inline.map((c) => `set [find name=${rosQuote(c)}] ${set.map((x) => `channel.${x}`).join(" ")}`));
          const back = old("channel.");
          if (back.length) undoWifiMain.push("/interface wifi configuration", ...m.ch5Inline.map((c) => `set [find name=${rosQuote(c)}] ${back.join(" ")}`));
        }
        if (widthChanged && !m.width5) undoWifiMain.push(`# The 5 GHz width was not set before. To go back to that, clear Width in WinBox (Wi-Fi → Channels${m.ch5Profiles.length ? ` → ${m.ch5Profiles.join(", ")}` : ""}).`);
        if (w.allowDfs && dfsChanged) notes.push("Radar (DFS) channels give 5 GHz more room, but an access point goes quiet for a minute after start-up or when it detects radar. The 10-minute weather-radar channels stay skipped.");
        if (w.width5 === "20/40/80/160mhz") notes.push("160 MHz uses most of the 5 GHz band; one neighbour on an overlapping channel slows everyone down. 80 MHz is the safer choice.");
        notes.push("Access points restart their 5 GHz radio to take the new channel settings: Wi-Fi drops for a few seconds.");
      }
    }
    if (lines.length) {
      section(S, `Wi-Fi "${m.ssid}"`);
      S.push(...lines);
    }
  }

  if (!changes.length) return { changes, script: "", undo: "", notes };

  const head = [
    `# Stribog: changes to ${ctx.site}, for RouterOS v7 (wifi package)`,
    ...changes.map((c) => `#   - ${c}`),
    "# Review every line, then paste it into the router's terminal (WinBox: New Terminal, or SSH).",
    "# Stribog does not apply this script. Secrets are not in this script.",
    "# The undo script takes back exactly these changes.",
  ];
  section(head, "First: a copy of the configuration as it is now");
  head.push("/export file=stribog-before-change");
  const script = [...head, ...S].join("\n").replace(/\n{3,}/g, "\n\n") + "\n";

  const undo = [
    `# Stribog: undo the changes to ${ctx.site}`,
    ...changes.map((c) => `#   - ${c}`),
    "# Removes what the change script added (found by its \"Stribog …\" comments) and sets back what it changed.",
    "# The configuration as it was before is also in the router's file stribog-before-change.rsc.",
    ...(undoWifiMain.length ? ["", ...undoWifiMain] : []),
    ...undoSides.flatMap((u) => ["", ...u]),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") + "\n";

  notes.unshift("The script starts by saving the configuration as it is now to the file stribog-before-change.rsc on the router, so you can always see what was there.");
  return { changes, script, undo, notes };
}
