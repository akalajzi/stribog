// The setup review: what is good, what is fragile, what to change, and exactly how.
//
// Rules read the normalized model plus the raw RouterOS config. Each finding explains why it
// matters in plain words and, where the fix is on the router, gives a RouterOS script to review.
// Nothing here changes anything.

import { connectionViews, type Device, type NetworkModel, type Radio } from "./model.ts";
import { inPool, isPrivateMac } from "./net.ts";
import { enabled, isTrue, list, menu, prop, single, type RosConfig, type Snapshot } from "./ros.ts";

export type Severity = "critical" | "warning" | "suggestion" | "info" | "pass";
export type Category = "internet" | "dns-dhcp" | "wifi" | "security" | "segmentation" | "maintenance" | "hardware";

export interface Fix {
  where: "router" | "ap" | "isp" | "device" | "plan";
  steps?: string[];
  cli?: string;
  caution?: string;
}

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  summary: string;
  detail?: string[];
  evidence?: string[];
  devices?: string[];
  fix?: Fix;
}

export interface Analysis {
  score: number;
  grade: "great" | "good" | "fair" | "poor";
  findings: Finding[];
  counts: Record<Severity, number>;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  internet: "Internet",
  "dns-dhcp": "Addresses & DNS",
  wifi: "Wi-Fi",
  security: "Router security",
  segmentation: "Separation",
  maintenance: "Maintenance",
  hardware: "Ports & power",
};

const WEIGHT: Record<Severity, number> = { critical: 20, warning: 5, suggestion: 1.5, info: 0, pass: 0 };
const SUGGESTION_CAP = 20;

interface Ctx {
  m: NetworkModel;
  cfg?: RosConfig;
  caps: RosConfig[];
  dev: (id?: string) => Device | undefined;
  clients: Device[];
  lan?: NetworkModel["networks"][number];
}

type Rule = (c: Ctx) => Finding | Finding[] | undefined;

export function analyze(model: NetworkModel, snap: Snapshot): Analysis {
  const cfg = snap.devices.find((d) => d.role === "router")?.config;
  const ctx: Ctx = {
    m: model,
    cfg,
    caps: snap.devices.filter((d) => d.role === "cap").map((d) => d.config),
    dev: (id) => model.devices.find((d) => d.id === id),
    clients: model.devices.filter((d) => d.mac && !d.managed),
    lan: model.networks.find((n) => n.role === "lan"),
  };
  const findings: Finding[] = [];
  for (const rule of RULES) {
    try {
      const out = rule(ctx);
      if (out) findings.push(...(Array.isArray(out) ? out : [out]));
    } catch (err) {
      findings.push({ id: `rule-error-${findings.length}`, severity: "info", category: "maintenance", title: "A check could not run", summary: String(err) });
    }
  }
  const order: Severity[] = ["critical", "warning", "suggestion", "info", "pass"];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const counts = Object.fromEntries(order.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
  // Suggestions are ideas, not faults: they can never sink the score on their own.
  const penalty = findings.reduce((n, f) => n + (f.severity === "suggestion" ? 0 : WEIGHT[f.severity]), 0) + Math.min(SUGGESTION_CAP, counts.suggestion * WEIGHT.suggestion);
  const score = Math.max(0, Math.round(100 - penalty));
  const grade = score >= 85 ? "great" : score >= 65 ? "good" : score >= 40 ? "fair" : "poor";
  return { score, grade, findings, counts };
}

const names = (ds: (Device | undefined)[]) => ds.filter(Boolean).map((d) => d!.name);
const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Internet

const doubleNat: Rule = ({ m }) => {
  if (m.wan.doubleNat !== true) {
    if (m.wan.addressKind === "public") return { id: "wan-public", severity: "pass", category: "internet", title: "The router has a public address", summary: `WAN address ${m.wan.address} is public, so there is a single NAT and port forwards work directly.` };
    return undefined;
  }
  const up = m.devices.find((d) => d.id === "upstream");
  const cgnat = m.wan.addressKind === "cgnat";
  return {
    id: "wan-double-nat",
    severity: "warning",
    category: "internet",
    title: cgnat ? "Behind carrier-grade NAT" : `Double NAT behind ${up?.name ?? "the ISP router"}`,
    summary: cgnat
      ? `The WAN address ${m.wan.address} is in the shared 100.64.0.0/10 range: the ISP translates your traffic again, so nothing can be reached from outside.`
      : `The router's WAN address ${m.wan.address ?? "(private)"} is private, so traffic is translated twice: once here and again in ${up?.name ?? "the ISP router"}.`,
    detail: [
      "Everyday browsing and streaming work fine. What breaks or gets awkward is anything that needs to be reached from outside: port forwards and VPN servers need a rule on both routers, consoles and calls report a strict NAT, and UPnP only opens the inner router.",
      "It also means two devices think they are the gateway, two DHCP servers, and Wi-Fi from the ISP router that sits outside your firewall.",
    ],
    evidence: [`WAN ${m.wan.iface}: ${m.wan.address ?? "private address"}${m.wan.gateway ? ` via ${m.wan.gateway}` : ""}`, m.wan.doubleNatCertainty === "inferred" ? "Inferred from private addresses on the WAN bridge" : "Read from the DHCP client"],
    devices: ["upstream", m.routerId ?? "router"],
    fix: {
      where: "isp",
      steps: [
        `Ask the ISP to put ${up?.name ?? "the ISP router"} in bridge mode (or the ONT in pass-through) so this router receives the public address.`,
        "If bridge mode is not offered, set the router as DMZ / exposed host on the ISP router as a fallback.",
        "Before the switch: remove temporary management access from the old network and check that the WAN firewall drops everything not coming from LAN.",
      ],
    },
  };
};

const upstreamDevices: Rule = ({ m }) => {
  // Seen only on the ISP router's side. "Answering now" comes from the router's ARP state.
  const outside = m.devices.filter((d) => d.zone === "upstream" && d.id !== "upstream" && d.mac);
  if (!outside.length) return undefined;
  const now = outside.filter((d) => d.status === "online");
  const earlier = outside.filter((d) => d.status !== "online");
  const where = m.wan.gateway ? m.wan.gateway.replace(/\.\d+$/, ".0/24") : "the upstream network";
  const evidence = [
    ...now.map((d) => `${d.name}: ${d.ip ?? "?"}${d.via?.port ? ` on ${d.via.port}` : ""}, answering now`),
    ...earlier.map((d) => `${d.name}: ${d.ip ?? "?"}, not answering recently`),
  ];
  if (!now.length)
    return {
      id: "wan-devices-outside",
      severity: "info",
      category: "segmentation",
      title: `The router remembers ${plural(earlier.length, "device")} from the ISP router's network`,
      summary: `None of them answered recently. They are entries in the router's address table (ARP) for ${where}, and may well be gone.`,
      evidence,
      devices: earlier.map((d) => d.id),
    };
  return {
    id: "wan-devices-outside",
    severity: "suggestion",
    category: "segmentation",
    title: `${plural(now.length, "device")} on the ISP router's network`,
    summary: `${join(names(now))} ${now.length === 1 ? "is" : "are"} on ${where}, outside this router's firewall.${earlier.length ? ` ${plural(earlier.length, "more was", "more were")} seen there earlier.` : ""}`,
    detail: [
      "Devices on the upstream side are not protected by this router's firewall, do not use its DNS settings, and reach your network only through port forwards.",
      "If they belong to you, move them to your own Wi-Fi or a LAN port.",
    ],
    evidence,
    devices: outside.map((d) => d.id),
    fix: { where: "device", steps: now.map((d) => `${d.name}: connect it to your Wi-Fi or a LAN port.`) },
  };
};

const legacyCompat: Rule = ({ m, cfg }) => {
  // Extra addresses the router holds on the WAN side, forwarded into the LAN: devices that still
  // live on the upstream network keep reaching LAN devices at their old addresses.
  const wanIf = m.wan.iface;
  if (!wanIf) return undefined;
  const ipOf = (a?: string) => a?.split("/")[0];
  const addrs = menu(cfg, "/ip/address").filter((a) => enabled(a) && !isTrue(a.dynamic) && a.interface === wanIf && ipOf(a.address) && ipOf(a.address) !== m.wan.address);
  const extra = new Set(addrs.map((a) => ipOf(a.address)!));
  const nat = menu(cfg, "/ip/firewall/nat").filter((r) => enabled(r) && r.action === "dst-nat" && extra.has(ipOf(r["dst-address"]) ?? ""));
  if (!nat.length) return undefined;
  const forwarded = [...extra].filter((ip) => nat.some((r) => ipOf(r["dst-address"]) === ip));
  const target = (ip: string) => {
    const to = nat.find((r) => ipOf(r["dst-address"]) === ip)?.["to-addresses"];
    const dev = to ? m.devices.find((d) => d.ip === to) : undefined;
    return `${ip} → ${to ?? "?"}${dev ? ` (${dev.name})` : ""}`;
  };
  return {
    id: "lan-legacy-compat",
    severity: "info",
    category: "internet",
    title: `The router answers for ${plural(forwarded.length, "extra address", "extra addresses")} on the upstream network`,
    summary: `It holds ${join(forwarded)} on ${wanIf} and forwards ${forwarded.length === 1 ? "it" : "them"} into your LAN, so devices on the ISP router's network can still reach LAN devices at those addresses. This is probably a migration aid.`,
    detail: ["Useful while devices move, but it hides stale configuration. Once nothing uses those addresses, remove them so problems surface instead of being silently translated."],
    evidence: forwarded.map(target),
    fix: {
      where: "router",
      cli:
        "# When nothing uses these addresses any more:\n" +
        forwarded.flatMap((ip) => [`/ip firewall nat remove [find action=dst-nat dst-address="${ip}"]`, `/ip address remove [find interface="${wanIf}" address="${addrs.find((a) => ipOf(a.address) === ip)!.address}"]`]).join("\n"),
    },
  };
};

// ---------------------------------------------------------------------------
// DNS & DHCP

const singleDns: Rule = ({ m, lan }) => {
  const dns = lan?.dhcp?.dns ?? [];
  if (!lan?.dhcp) return undefined;
  if (dns.length >= 2) return { id: "dns-redundant", severity: "pass", category: "dns-dhcp", title: "Clients get two DNS servers", summary: `DHCP hands out ${dns.join(" and ")}.` };
  const host = m.devices.find((d) => d.ip && d.ip === dns[0] && !d.managed);
  if (!dns.length) return { id: "dns-none", severity: "warning", category: "dns-dhcp", title: "DHCP hands out no DNS server", summary: "Clients fall back to whatever they remember; name resolution may fail after a reboot.", fix: { where: "router", cli: `/ip dhcp-server network set [find address="${lan.cidr}"] dns-server=${lan.gateway}` } };
  if (!host) return { id: "dns-single-router", severity: "pass", category: "dns-dhcp", title: "The router answers DNS", summary: `Clients use ${dns[0]}, which is the router itself.` };
  return {
    id: "dns-single-host",
    severity: "warning",
    category: "dns-dhcp",
    title: `All name lookups depend on ${host.name}`,
    summary: `DHCP gives clients a single DNS server, ${dns[0]} (${host.name}). If it restarts or its DNS service stops, every device loses name resolution and the internet looks down.`,
    detail: [
      "This is the most common way a home network “breaks” when nothing is wrong with the internet: the filtering DNS box is updating, rebooting or out of memory.",
      "A second server removes the single point of failure. If the second one does not filter, some lookups will skip ad blocking while both are up; a second filtering instance (for example on another always-on machine) avoids that.",
    ],
    evidence: [`/ip dhcp-server network ${lan.cidr}: dns-server=${dns.join(",")}`],
    devices: [host.id],
    fix: {
      where: "router",
      cli: `# Let the router answer as a fallback, using ${host.name} first and a public resolver behind it\n/ip dns set allow-remote-requests=yes servers=${dns[0]},1.1.1.1,9.9.9.9\n/ip dhcp-server network set [find address="${lan.cidr}"] dns-server=${dns[0]},${lan.gateway}`,
      caution: "allow-remote-requests is safe only while the input firewall drops DNS from the WAN side (the default rules here do).",
    },
  };
};

const routerDns: Rule = ({ m, cfg }) => {
  const servers = list(prop(single(cfg, "/ip/dns"), "servers"));
  const host = m.devices.find((d) => d.ip && servers.length === 1 && d.ip === servers[0] && !d.managed);
  if (!host) return undefined;
  const ntpNames = menu(cfg, "/system/ntp/client/servers").map((s) => s.address ?? "").filter((a) => /[a-z]/i.test(a));
  return {
    id: "dns-router-depends",
    severity: "warning",
    category: "dns-dhcp",
    title: `The router itself only resolves names through ${host.name}`,
    summary: `The router's own resolver points only at ${servers[0]}. When ${host.name} is down, the router cannot look up its NTP servers${ntpNames.length ? ` (${ntpNames.join(", ")})` : ""} or check for updates.`,
    detail: ["Infrastructure should not depend on the devices it serves. A wrong clock after a power cut breaks certificates and logs, and it is hard to diagnose."],
    evidence: [`/ip dns servers=${servers.join(",")}`, ...ntpNames.map((n) => `NTP server by name: ${n}`)],
    devices: [host.id, m.routerId ?? "router"],
    fix: { where: "router", cli: `# Same line as the DNS fallback fix above; applying either covers both.\n/ip dns set servers=${servers[0]},1.1.1.1,9.9.9.9` },
  };
};

const privateMacReservations: Rule = ({ m }) => {
  const res = m.devices.filter((d) => d.reserved && d.privateMac);
  if (!res.length) return undefined;
  const offline = res.filter((d) => d.status === "offline");
  // A device with the same first name word online on a different, dynamic address is the smoking gun.
  const lookalikes = offline
    .map((d) => {
      const word = (d.leaseComment ?? d.name).split(/\s+/)[0]?.toLowerCase();
      const twin = m.devices.find((x) => x.id !== d.id && !x.reserved && x.status === "online" && word && x.name.toLowerCase().startsWith(word));
      return twin ? `${twin.name} is online as ${twin.mac} on ${twin.ip} (from the pool), not on its reserved ${d.ip}` : undefined;
    })
    .filter((x): x is string => !!x);
  return {
    id: "dhcp-private-mac-reservations",
    severity: offline.length ? "warning" : "suggestion",
    category: "dns-dhcp",
    title: `${plural(res.length, "reservation")} ${res.length === 1 ? "is" : "are"} tied to a private (random) MAC address`,
    summary: `Phones and laptops can rotate their private Wi-Fi address, and then a reservation silently stops matching. ${offline.length ? `${plural(offline.length, "of these is", "of these are")} not in use right now.` : ""}`.trim(),
    detail: [
      "Anything that relies on the fixed address (DNS filter profiles, firewall rules, port forwards) then applies to nobody, and the device takes a random address from the pool.",
      "For devices that need a fixed identity, turn the private address off for this network only, or set it to “fixed”, then re-create the reservation.",
    ],
    evidence: [...res.map((d) => `${d.leaseComment ?? d.name}: ${d.mac} → ${d.ip} (${d.status})`), ...new Set(lookalikes)],
    devices: res.map((d) => d.id),
    fix: {
      where: "device",
      steps: [
        "macOS / iOS: Wi-Fi → network details → Private Wi-Fi Address → Fixed (or Off).",
        "Android: Wi-Fi → network → Privacy → Use device MAC.",
        "Windows: Wi-Fi → network properties → Random hardware addresses → Off.",
        "Then bind the reservation to the new address and delete the stale ones.",
      ],
      cli: `# After the device reconnects with its fixed address:\n/ip dhcp-server lease make-static [find mac-address=<NEW-MAC>]\n/ip dhcp-server lease remove [find mac-address=<OLD-MAC>]`,
    },
  };
};

const unboundReservations: Rule = ({ m }) => {
  const waiting = m.devices.filter((d) => d.reserved && !d.privateMac && d.zone !== "upstream" && d.status === "offline");
  const moved = m.devices.filter((d) => d.reserved && d.zone === "upstream");
  if (!waiting.length && !moved.length) return undefined;
  return {
    id: "dhcp-unused-reservations",
    severity: "info",
    category: "dns-dhcp",
    title: `${plural(waiting.length + moved.length, "reservation")} not in use`,
    summary: "Reserved addresses with no device on them right now. Fine for devices that are off or not migrated yet; stale ones are worth deleting.",
    evidence: [...moved.map((d) => `${d.name}: reserved ${d.facts.find((f) => f.startsWith("Reserved"))?.replace(/^Reserved /, "") ?? ""}`.replace(/: reserved $/, ": reserved, still on the old network")), ...waiting.map((d) => `${d.name}: ${d.ip}, not seen`)],
    devices: [...moved, ...waiting].map((d) => d.id),
  };
};

const poolCheck: Rule = ({ m, lan }) => {
  const d = lan?.dhcp;
  if (!d) return undefined;
  const inside = m.devices.filter((x) => x.reserved && x.ip && inPool(x.ip, d.pool) && x.zone === "lan");
  const out: ReturnType<Rule> = [];
  if (inside.length)
    out.push({
      id: "dhcp-reservations-in-pool",
      severity: "suggestion",
      category: "dns-dhcp",
      title: "Some reservations sit inside the dynamic pool",
      summary: "It works, but keeping fixed addresses outside the pool makes the plan obvious and avoids surprises when a reservation is removed.",
      evidence: inside.map((x) => `${x.name}: ${x.ip} in pool ${d.pool.join(",")}`),
      devices: inside.map((x) => x.id),
    });
  else out.push({ id: "dhcp-reservations-outside-pool", severity: "pass", category: "dns-dhcp", title: "Fixed addresses are kept outside the pool", summary: `The pool (${d.pool.join(", ")}) and the reservations do not overlap.` });
  if (d.used !== undefined) {
    const pct = d.size ? d.used / d.size : 0;
    out.push(
      pct > 0.8
        ? { id: "dhcp-pool-full", severity: "warning", category: "dns-dhcp", title: "The address pool is nearly full", summary: `${d.used} of ${d.size} addresses in use. New devices may not get an address.`, fix: { where: "router", cli: `/ip pool set [find name="${d.server}"] ranges=...` } }
        : { id: "dhcp-pool-ok", severity: "pass", category: "dns-dhcp", title: "Plenty of free addresses", summary: `${d.used} of ${d.size} pool addresses in use.` },
    );
  }
  return out;
};

// ---------------------------------------------------------------------------
// Wi-Fi

const signalWord = (s?: number) => (s === undefined ? "unknown" : s >= -55 ? "excellent" : s >= -65 ? "good" : s >= -72 ? "fair" : "weak");

const band24Clients: Rule = ({ clients }) => {
  const on24 = connectionViews(clients).filter((d) => d.via?.kind === "wifi" && d.via.band === "2.4");
  return on24.map((d): Finding => {
    const sig = d.via?.signal;
    if (d.only24)
      return {
        id: `wifi-24-expected-${d.mac}`,
        severity: sig !== undefined && sig < -70 ? "suggestion" : "info",
        category: "wifi",
        title: `${d.name} is on 2.4 GHz, which is expected`,
        summary: `${d.name} only has a 2.4 GHz radio, so it cannot use 5 GHz. Its signal is ${signalWord(sig)}${sig !== undefined ? ` (${sig} dBm)` : ""}${d.via?.txRate ? ` at ${d.via.txRate}` : ""}.`,
        detail: [
          sig !== undefined && sig < -65
            ? "That is enough for control traffic and LAN printing, but camera streaming and large file transfers will be slow and drop out more easily. An access point closer to it is the real fix; nothing on the router will make 2.4 GHz reach further."
            : "That is comfortable for this kind of device.",
          "Keep 2.4 GHz at 20 MHz on channels 1, 6 or 11, and make sure the SSID it uses keeps WPA2 available; many 2.4-only devices cannot join WPA3-only networks.",
        ],
        evidence: [`${d.via?.ssid ?? "?"} on ${d.via?.radio ?? "?"}: ${sig ?? "?"} dBm, tx ${d.via?.txRate ?? "?"}, rx ${d.via?.rxRate ?? "?"}`],
        devices: [d.id],
        fix: sig !== undefined && sig < -65 ? { where: "plan", steps: [`Place the next access point closer to ${d.name}.`] } : undefined,
      };
    return {
      id: `wifi-24-capable-${d.mac}`,
      severity: "suggestion",
      category: "wifi",
      title: `${d.name} is on 2.4 GHz`,
      summary: `${d.name} probably supports 5 GHz but is connected on 2.4 GHz (${sig ?? "?"} dBm), which is slower and more crowded.`,
      detail: ["Devices usually stay on 2.4 GHz because 5 GHz is too weak where they are, or because they joined a 2.4-only SSID."],
      evidence: [`${d.via?.ssid} on ${d.via?.radio}: ${sig ?? "?"} dBm`],
      devices: [d.id],
    };
  });
};

const weakClients: Rule = ({ clients }) => {
  const weak = connectionViews(clients).filter((d) => d.via?.kind === "wifi" && d.via.band !== "2.4" && (d.via.signal ?? 0) < -70);
  return weak.map((d) => ({
    id: `wifi-weak-${d.mac}`,
    severity: "suggestion" as const,
    category: "wifi" as const,
    title: `${d.name} has a weak signal`,
    summary: `${d.via?.signal} dBm on ${d.via?.band} GHz${d.via?.txRate ? ` (${d.via.txRate})` : ""}. Below about −70 dBm, speed drops and connections stall.`,
    detail: d.kind === "server" ? ["If this is only a standby path for a wired machine, it is fine as long as the wired link stays up."] : undefined,
    devices: [d.id],
  }));
};

const duplicateSsids: Rule = ({ m }) => {
  const byNet = new Map<string, string[]>();
  for (const s of m.ssids) if (s.network) byNet.set(s.network, [...(byNet.get(s.network) ?? []), s.name]);
  const out: Finding[] = [];
  for (const [net, ss] of byNet) {
    if (ss.length < 2) continue;
    const n = m.networks.find((x) => x.id === net);
    out.push({
      id: `wifi-duplicate-ssids-${net}`,
      severity: "suggestion",
      category: "wifi",
      title: `${ss.length} Wi-Fi names lead to the same network`,
      summary: `${join(ss)} all end up on ${n?.label ?? net}. Every extra SSID broadcasts its own beacons on every radio, using airtime, and splits devices for no benefit.`,
      detail: ["Keep one name per purpose. If a second name is needed, give it a different purpose, such as a guest or IoT network with its own rules."],
      evidence: m.ssids.filter((s) => s.network === net).map((s) => `${s.name}: ${s.bands.join(" + ")} GHz, ${s.auth.join("/")}, ${s.clients} clients`),
      fix: { where: "router", steps: ["Move the remaining devices to the SSID you keep, then disable the other one (or repurpose it as a guest network)."] },
    });
  }
  return out;
};

const wpa2Only: Rule = ({ m }) => {
  const weak = m.ssids.filter((s) => s.auth.length && !s.auth.some((a) => a.startsWith("wpa3")));
  const strong = m.ssids.filter((s) => s.auth.some((a) => a.startsWith("wpa3")));
  const out: Finding[] = weak.map((s) => ({
    id: `wifi-wpa2-only-${s.name}`,
    severity: "suggestion",
    category: "wifi",
    title: `“${s.name}” uses WPA2 only`,
    summary: `WPA2-PSK is still solid with a long passphrase, but WPA3 protects against offline password guessing. WPA2/WPA3 mixed mode lets newer devices use WPA3 while older ones keep working.`,
    detail: ["Test mixed mode with the oldest device on this SSID first. Some printers and IoT devices refuse to join when WPA3 is offered; those belong on a separate WPA2 network for IoT anyway."],
    evidence: [`${s.name}: ${s.auth.join(", ")}`],
    fix: { where: "router", cli: `/interface wifi security set [find name="${s.security ?? "<profile>"}"] authentication-types=wpa2-psk,wpa3-psk` },
  }));
  if (strong.length) out.push({ id: "wifi-wpa3-available", severity: "pass", category: "wifi", title: "WPA3 is available", summary: `${join(strong.map((s) => `“${s.name}”`))} offer${strong.length === 1 ? "s" : ""} WPA3 alongside WPA2.` });
  return out;
};

const roaming: Rule = ({ m }) => {
  const aps = m.devices.filter((d) => d.kind === "ap" && d.managed);
  const plannedAps = m.planned.filter((p) => p.kind === "ap");
  const noFt = m.ssids.filter((s) => !s.ft);
  if (!noFt.length) return { id: "wifi-ft-on", severity: "pass", category: "wifi", title: "Fast roaming (802.11r) is enabled", summary: "Devices can move between access points without a full re-authentication." };
  if (aps.length + plannedAps.length < 2) return undefined;
  return {
    id: "wifi-ft-off",
    severity: aps.length >= 2 ? "warning" : "suggestion",
    category: "wifi",
    title: aps.length >= 2 ? "Fast roaming is off with several access points" : "Turn on fast roaming when the second access point arrives",
    summary: `With ${aps.length >= 2 ? `${aps.length} access points` : "a second access point planned"}, phones and laptops will hand over between them. Without 802.11r each move is a full reconnect, which drops calls and video for a moment.`,
    detail: ["Enable FT per SSID and test with every important device; a few older clients misbehave with FT and can stay on a separate SSID."],
    evidence: noFt.map((s) => `${s.name}: ft=no`),
    fix: { where: "router", cli: `/interface wifi security set [find] ft=yes ft-over-ds=yes`, caution: "Test each SSID after the change; if a device cannot reconnect, revert FT on that SSID's security profile." },
  };
};

const fiveGhzPlan: Rule = ({ m }) => {
  const r5 = m.radios.filter((r) => r.band === "5");
  if (!r5.length) return undefined;
  const plannedAps = m.planned.filter((p) => p.kind === "ap").length;
  const aps = new Set(r5.map((r) => r.apId)).size;
  const sample = r5[0]!;
  const freqs = sample.plan?.frequencies ?? [];
  const width = sample.current?.width ?? (sample.plan?.width?.includes("80") ? 80 : sample.plan?.width?.includes("40") ? 40 : 20);
  const blocks = freqs.length ? Math.max(1, Math.floor(freqs.length / (width / 20))) : 0;
  const out: Finding[] = [];
  if (sample.current && !sample.current.dfs) out.push({ id: "wifi-5-non-dfs", severity: "pass", category: "wifi", title: "5 GHz avoids radar channels", summary: `Channel ${sample.current.channel} at ${sample.current.width} MHz needs no radar checks, so it never goes silent for a minute to listen for radar.` });
  if (freqs.length && blocks < aps + plannedAps && aps + plannedAps >= 2) {
    out.push({
      id: "wifi-5-one-block",
      severity: aps >= 2 ? "warning" : "suggestion",
      category: "wifi",
      title: "Only one 5 GHz channel is available for two access points",
      summary: `The channel plan allows ${freqs.join(", ")} MHz at ${width} MHz width${sample.plan?.skipDfs ? " and skips radar (DFS) channels" : ""}. That is exactly one ${width} MHz block, so a second access point would share it and both would slow down where they overlap.`,
      detail: [
        "Pick one: allow DFS channels (52–64, 100–140 in the EU) so each access point gets its own 80 MHz block, or drop to 40 MHz (36–40 and 44–48), which still gives each AP plenty for a home.",
        "DFS channels can go quiet for about a minute when radar is detected; for a home that is usually acceptable, and it is the way to keep 80 MHz on two access points.",
      ],
      evidence: r5.map((r) => `${r.iface}: allowed ${r.plan?.frequencies.join(",") ?? "?"}, width ${r.plan?.width ?? "?"}${r.current ? `, now ch ${r.current.channel} @ ${r.current.width} MHz` : ""}`),
      fix: {
        where: "router",
        cli: `# Option A: allow DFS so the second AP can use 52-64\n/interface wifi channel set [find band~"5ghz"] skip-dfs-channels=10min-cac frequency=5180,5200,5220,5240,5260,5280,5300,5320\n\n# Option B: stay on 36-48 and use 40 MHz\n/interface wifi channel set [find band~"5ghz"] width=20/40mhz`,
      },
    });
  }
  return out;
};

const band24Plan: Rule = ({ m }) => {
  const r = m.radios.find((x) => x.band === "2.4");
  if (!r) return undefined;
  const okChannels = (r.plan?.frequencies ?? []).every((f) => [2412, 2437, 2462].includes(f));
  const okWidth = (r.current?.width ?? 20) === 20 && !(r.plan?.width ?? "").includes("40");
  if (okChannels && okWidth)
    return { id: "wifi-24-plan", severity: "pass", category: "wifi", title: "2.4 GHz uses 20 MHz on channels 1, 6 and 11", summary: "That is the only arrangement where neighbouring networks do not overlap each other." };
  return {
    id: "wifi-24-plan-bad",
    severity: "suggestion",
    category: "wifi",
    title: "2.4 GHz channel plan could overlap",
    summary: "On 2.4 GHz, only 20 MHz on channels 1, 6 or 11 avoids overlapping with neighbours.",
    fix: { where: "router", cli: `/interface wifi channel set [find band~"2ghz"] width=20mhz frequency=2412,2437,2462` },
  };
};

const capVersions: Rule = ({ m }) => {
  const router = m.devices.find((d) => d.id === m.routerId);
  const aps = m.devices.filter((d) => d.kind === "ap" && d.managed && d.version);
  const behind = aps.filter((a) => router?.version && a.version !== router.version);
  if (!aps.length) return undefined;
  if (!behind.length) return { id: "cap-versions-match", severity: "pass", category: "maintenance", title: "Access points run the same RouterOS as the controller", summary: `All on ${router?.version}.` };
  return {
    id: "cap-versions-differ",
    severity: "warning",
    category: "maintenance",
    title: `${plural(behind.length, "access point")} on a different RouterOS than the controller`,
    summary: `${join(behind.map((a) => `${a.name} runs ${a.version}`))}; the controller runs ${router?.version}. CAPsMAN features and fixes assume matching versions.`,
    evidence: [`${router?.name}: ${router?.version}`, ...behind.map((a) => `${a.name} (${a.model ?? "AP"}): ${a.version}`)],
    devices: behind.map((a) => a.id),
    fix: {
      where: "ap",
      cli: `# On each access point (same update channel as the router)\n/system package update set channel=long-term\n/system package update install\n\n# Optional, on the router: let CAPsMAN suggest matching versions\n/interface wifi capsman set upgrade-policy=suggest-same-version`,
      caution: "The AP reboots; Wi-Fi on it is gone for 2–3 minutes.",
    },
  };
};

const updateChannels: Rule = ({ m, cfg, caps }) => {
  const rc = prop(single(cfg, "/system/package/update"), "channel", "stable");
  const differing = caps.filter((c) => prop(single(c, "/system/package/update"), "channel", "stable") !== rc);
  if (!differing.length) return undefined;
  return {
    id: "update-channels-differ",
    severity: "suggestion",
    category: "maintenance",
    title: "The router and access points follow different update channels",
    summary: `The router checks “${rc}”${rc === "stable" ? " (the default)" : ""}, while ${plural(differing.length, "access point")} check${differing.length === 1 ? "s" : ""} “${prop(single(differing[0], "/system/package/update"), "channel", "stable")}”. Pick one so they stay on matching versions.`,
    fix: { where: "router", cli: `/system package update set channel=long-term` },
    devices: [m.routerId ?? "router"],
  };
};

const wifiBasics: Rule = ({ m, cfg }) => {
  const out: Finding[] = [];
  const confs = menu(cfg, "/interface/wifi/configuration");
  if (confs.length && confs.every((c) => c.country)) out.push({ id: "wifi-country", severity: "pass", category: "wifi", title: "Wi-Fi country is set", summary: `Radios use the ${confs[0]!.country} regulatory rules for channels and power.` });
  else if (confs.length) out.push({ id: "wifi-country-missing", severity: "warning", category: "wifi", title: "Wi-Fi country is not set everywhere", summary: "Without a country, radios may use channels or power that are not allowed here, or avoid ones that are." });
  const capsman = single(cfg, "/interface/wifi/capsman");
  if (capsman && isTrue(capsman.enabled)) {
    const ifs = list(capsman.interfaces);
    const wanSide = ifs.filter((i) => m.networks.find((n) => n.bridge === i)?.role === "wan");
    out.push(
      ifs.length && !wanSide.length
        ? { id: "capsman-scope", severity: "pass", category: "wifi", title: "Access points are managed only from the home LAN", summary: `CAPsMAN listens on ${ifs.join(", ")}.` }
        : { id: "capsman-scope-wide", severity: "warning", category: "security", title: "CAPsMAN listens beyond the home LAN", summary: "Limit CAPsMAN to LAN interfaces so nothing on the upstream side can register as an access point.", fix: { where: "router", cli: `/interface wifi capsman set interfaces=${m.networks.find((n) => n.role === "lan")?.bridge ?? "<lan-bridge>"}` } },
    );
  }
  return out;
};

// ---------------------------------------------------------------------------
// Router security

const services: Rule = ({ cfg, lan }) => {
  const svc = menu(cfg, "/ip/service");
  const DEFAULT_ON = ["www", "ssh", "winbox", "api", "api-ssl", "ftp", "telnet"];
  const state = (n: string) => {
    const r = svc.find((s) => s.name === n);
    return { on: r ? !isTrue(r.disabled) : DEFAULT_ON.includes(n), address: r?.address ?? "" };
  };
  const out: Finding[] = [];
  const legacy = ["telnet", "ftp"].filter((n) => state(n).on);
  if (legacy.length)
    out.push({ id: "svc-insecure", severity: "warning", category: "security", title: `${cap(join(legacy.map((n) => n.toUpperCase().replace("TELNET", "Telnet"))))} ${legacy.length === 1 ? "is" : "are"} enabled`, summary: "These send passwords in clear text and are not needed for anything modern.", fix: { where: "router", cli: legacy.map((n) => `/ip service disable ${n}`).join("\n") } });
  else out.push({ id: "svc-legacy-off", severity: "pass", category: "security", title: "Telnet and FTP are off", summary: "No clear-text management protocols are listening." });

  const open = ["www", "ssh", "winbox"].filter((n) => state(n).on && !state(n).address);
  if (open.length)
    out.push({
      id: "svc-unrestricted",
      severity: "suggestion",
      category: "security",
      title: "Management is open to every device on the LAN",
      summary: `${join(open.map((n) => (n === "www" ? "WebFig (plain HTTP)" : n === "ssh" ? "SSH" : "WinBox")))} accept${open.length === 1 ? "s" : ""} connections from any address. Any compromised TV, printer or guest laptop can try to log in.`,
      detail: [
        state("www").on ? "WebFig over HTTP also sends the admin password unencrypted across Wi-Fi. Prefer www-ssl, or restrict www to the machines you administer from." : "",
        "The firewall already blocks the internet side; this is about the inside.",
      ].filter(Boolean),
      evidence: open.map((n) => `/ip service ${n}: enabled, address=(any)`),
      fix: { where: "router", cli: open.map((n) => `/ip service set ${n} address=${lan?.cidr ?? "10.0.0.0/24"}`).join("\n") + `\n# Tighter: list only your admin machines, e.g. address=192.168.88.10/32,192.168.88.11/32`, caution: "Make sure the machine you manage from is inside the allowed range before applying, or you lock yourself out of that service." },
    });
  return out;
};

const tempRules: Rule = ({ cfg }) => {
  const rules = menu(cfg, "/ip/firewall/filter").filter((r) => /temp|temporary|staging/i.test(r.comment ?? ""));
  if (!rules.length) return undefined;
  const active = rules.filter(enabled);
  const fromWan = active.filter((r) => r.chain === "input" && r.action === "accept" && (r["in-interface"] || r["src-address"]));
  return {
    id: "fw-temporary-rules",
    severity: fromWan.length ? "warning" : "suggestion",
    category: "security",
    title: `${plural(rules.length, "temporary firewall rule")} still present`,
    summary: fromWan.length
      ? `${plural(fromWan.length, "active rule")} let${fromWan.length === 1 ? "s" : ""} the old network reach the router's login (ports ${[...new Set(fromWan.map((r) => r["dst-port"]).filter(Boolean))].join(", ")}). Anyone on the ISP router's Wi-Fi can reach the management pages, and after a bridge-mode switch the same rule would face the internet.`
      : "Disabled leftovers from setup. They do nothing, but they make the rule list harder to trust.",
    evidence: rules.map((r) => `${enabled(r) ? "active" : "disabled"}: ${r.chain} ${r.action} ${r["src-address"] ?? ""} ${r.protocol ?? ""} ${r["dst-port"] ?? ""} — “${r.comment}”`),
    fix: { where: "router", cli: `# Remove once you no longer manage the router from the old network\n/ip firewall filter remove [find comment~"TEMP"]` },
  };
};

const firewallDefaults: Rule = ({ cfg }) => {
  const f = menu(cfg, "/ip/firewall/filter").filter(enabled);
  if (!f.length) return { id: "fw-empty", severity: "critical", category: "security", title: "No IPv4 firewall rules", summary: "Nothing stops the internet side from reaching the router or, through NAT gaps, the LAN.", fix: { where: "router", steps: ["Restore the default configuration firewall (System → Reset Configuration keeps a backup) or apply the defconf filter rules."] } };
  const inputDrop = f.some((r) => r.chain === "input" && r.action === "drop" && (r["in-interface-list"] === "!LAN" || r["in-interface-list"] === "WAN"));
  const fwdDrop = f.some((r) => r.chain === "forward" && r.action === "drop" && r["connection-nat-state"] === "!dstnat");
  const invalid = f.some((r) => r.action === "drop" && r["connection-state"] === "invalid");
  if (inputDrop && fwdDrop && invalid)
    return { id: "fw-defaults", severity: "pass", category: "security", title: "The firewall blocks the internet side", summary: "Router access from outside the LAN is dropped, unsolicited inbound traffic is dropped unless port-forwarded, and invalid packets are discarded." };
  return { id: "fw-gaps", severity: "warning", category: "security", title: "The firewall is missing default protections", summary: [!inputDrop && "no final drop for router access from outside the LAN", !fwdDrop && "no drop for unsolicited inbound traffic", !invalid && "no drop for invalid packets"].filter(Boolean).join("; ") + "." };
};

const usbSharing: Rule = ({ m, cfg }) => {
  const d = single(cfg, "/disk/settings");
  if (!d || !(isTrue(d["auto-smb-sharing"]) || isTrue(d["auto-media-sharing"]))) return undefined;
  const iface = d["auto-media-interface"] ?? "";
  const wan = m.networks.find((n) => n.bridge === iface)?.role === "wan";
  return {
    id: "usb-auto-sharing",
    severity: wan ? "warning" : "suggestion",
    category: "security",
    title: wan ? "USB drives would be shared on the upstream side" : "USB drives are shared automatically",
    summary: `Any USB drive plugged into the router is shared over SMB${isTrue(d["auto-media-sharing"]) ? " and as media" : ""} on “${iface}”${wan ? ", which is the WAN/upstream bridge, not your home LAN" : ""}.`,
    detail: [wan ? "The input firewall currently drops this traffic, so it is not exposed today; but it is the wrong side, and one firewall change away from being reachable by everything on the old network." : "Fine if intended; otherwise turn it off so a forgotten stick is not visible to every device."],
    evidence: [`/disk settings auto-media-interface=${iface} auto-smb-sharing=${d["auto-smb-sharing"] ?? "no"} auto-media-sharing=${d["auto-media-sharing"] ?? "no"}`],
    fix: { where: "router", cli: `/disk settings set auto-smb-sharing=no auto-media-sharing=no\n# or, to keep it on the home LAN only:\n# /disk settings set auto-media-interface=${m.networks.find((n) => n.role === "lan")?.bridge ?? "<lan-bridge>"}` },
  };
};

const sshForwarding: Rule = ({ cfg }) => {
  const v = prop(single(cfg, "/ip/ssh"), "forwarding-enabled", "no");
  if (v === "no") return undefined;
  return {
    id: "ssh-forwarding",
    severity: "suggestion",
    category: "security",
    title: "SSH port forwarding is enabled on the router",
    summary: `forwarding-enabled=${v} lets an SSH session to the router tunnel into the LAN. It is handy for reaching access points during setup, but it widens what a stolen admin login can do.`,
    fix: { where: "router", cli: `/ip ssh set forwarding-enabled=no` },
  };
};

const lanOnlyTools: Rule = ({ cfg }) => {
  const mac = single(cfg, "/tool/mac-server");
  const nd = single(cfg, "/ip/neighbor/discovery-settings");
  const ok = mac?.["allowed-interface-list"] === "LAN" && nd?.["discover-interface-list"] === "LAN";
  if (!ok) return undefined;
  return { id: "lan-only-discovery", severity: "pass", category: "security", title: "Discovery and MAC access stay on the LAN", summary: "Neighbour discovery and MAC-Telnet/WinBox only answer on LAN interfaces." };
};

const identity: Rule = ({ m, cfg }) => {
  const name = prop(single(cfg, "/system/identity"), "name", "MikroTik");
  if (name !== "MikroTik") return undefined;
  return {
    id: "router-identity",
    severity: "suggestion",
    category: "maintenance",
    title: "The router still has the default name",
    summary: "Its identity is “MikroTik”. A real name shows up in logs, CAPsMAN, neighbour lists and backups, and makes the shell prompt tell you which device you are on.",
    devices: [m.routerId ?? "router"],
    fix: { where: "router", cli: `/system identity set name=${(m.devices.find((d) => d.id === m.routerId)?.name ?? "router").toLowerCase()}-gateway` },
  };
};

const leftovers: Rule = ({ cfg }) => {
  const items = [
    ...menu(cfg, "/ip/address").filter((r) => isTrue(r.disabled)).map((r) => `address ${r.address} (disabled)`),
    ...menu(cfg, "/ip/dhcp-server").filter((r) => isTrue(r.disabled)).map((r) => `DHCP server ${r.name} (disabled)`),
    ...menu(cfg, "/ip/dns/static").filter((r) => isTrue(r.disabled)).map((r) => `DNS entry ${r.name} (disabled)`),
    ...menu(cfg, "/ip/dhcp-server/network").filter((n) => n.comment === "defconf" && !menu(cfg, "/ip/address").some((a) => enabled(a) && a.network && n.address?.startsWith(a.network))).map((n) => `DHCP network ${n.address} (unused)`),
  ];
  if (items.length < 2) return undefined;
  return {
    id: "config-leftovers",
    severity: "info",
    category: "maintenance",
    title: `${items.length} unused leftovers from the default configuration`,
    summary: "Harmless, but they make the configuration harder to read and are easy to re-enable by mistake.",
    evidence: items,
    fix: { where: "router", cli: `/ip address remove [find disabled=yes]\n/ip dhcp-server remove [find disabled=yes]\n/ip dns static remove [find disabled=yes]` },
  };
};

const backups: Rule = ({ cfg }) => {
  const sched = menu(cfg, "/system/scheduler").filter(enabled);
  const scripts = menu(cfg, "/system/script");
  const has = sched.some((s) => /backup|export/i.test(`${s.name} ${s["on-event"]}`)) || scripts.some((s) => /backup|export/i.test(`${s.name} ${s.source}`));
  if (has) return { id: "backup-scheduled", severity: "pass", category: "maintenance", title: "Configuration backups are scheduled", summary: "The router exports its configuration on a schedule." };
  return {
    id: "backup-none",
    severity: "suggestion",
    category: "maintenance",
    title: "No automatic configuration backup",
    summary: "The router does not export its configuration on a schedule. If it fails, the latest copy is whatever was saved by hand.",
    detail: ["A nightly export is tiny. Keep a copy off the router (NAS, git), because the router's own storage dies with the router."],
    fix: { where: "router", cli: `/system scheduler add name=nightly-export interval=1d start-time=03:30:00 on-event="/export show-sensitive=no file=nightly-export"\n# Then copy nightly-export.rsc off the router, e.g. with scp from the NAS.` },
  };
};

const ntp: Rule = ({ cfg }) => {
  const c = single(cfg, "/system/ntp/client");
  if (!isTrue(c?.enabled)) return { id: "ntp-off", severity: "suggestion", category: "maintenance", title: "Time sync is off", summary: "Without NTP the router's clock drifts, which breaks certificates, logs and scheduled tasks.", fix: { where: "router", cli: `/system ntp client set enabled=yes\n/system ntp client servers add address=pool.ntp.org` } };
  return { id: "ntp-on", severity: "pass", category: "maintenance", title: "The clock is synchronised", summary: `NTP client on${isTrue(single(cfg, "/system/ntp/server")?.enabled) ? ", and the router serves time to the LAN" : ""}.` };
};

// ---------------------------------------------------------------------------
// Separation

const segmentation: Rule = ({ m }) => {
  const nets = m.networks.filter((n) => n.role !== "wan");
  const hasGuest = nets.some((n) => n.role === "guest");
  const hasIot = nets.some((n) => n.role === "iot");
  const lanDevices = m.devices.filter((d) => d.zone === "lan" && d.mac && !d.managed);
  const iot = lanDevices.filter((d) => ["tv", "printer", "printer3d", "iot", "camera", "console"].includes(d.kind));
  const valuable = lanDevices.filter((d, _, all) => ["nas", "server"].includes(d.kind) && !all.some((o) => o !== d && ["nas", "server"].includes(o.kind) && d.name.startsWith(o.name + " ")));
  const out: Finding[] = [];
  if (!hasIot && iot.length && valuable.length)
    out.push({
      id: "seg-flat-network",
      severity: "suggestion",
      category: "segmentation",
      title: "Smart devices share a network with your servers",
      summary: `${join(names(iot))} sit on the same network as ${join(names(valuable))}. If one of them is compromised, it can reach file shares and admin pages directly.`,
      detail: [
        "TVs, printers and gadgets get fewer security updates than computers. A separate IoT network (its own SSID and VLAN) lets them reach the internet and only the specific services they need, such as printing from your laptop.",
        "For a small office the same idea becomes: staff, guests and devices on separate networks.",
      ],
      devices: [...iot, ...valuable].map((d) => d.id),
      fix: { where: "plan", steps: ["Create an IoT network (VLAN + SSID, WPA2 for compatibility).", "Allow IoT → internet, LAN → IoT; block IoT → LAN.", "Move devices over one by one; reserve their addresses on the new network."] },
    });
  if (!hasGuest)
    out.push({
      id: "seg-no-guest",
      severity: "suggestion",
      category: "segmentation",
      title: "No guest Wi-Fi",
      summary: "Visitors get your main Wi-Fi password and full access to the home network. A guest network gives them internet only, and its password can be shared freely.",
      fix: { where: "plan", steps: ["Add a guest SSID on its own network with client isolation and internet-only access."] },
    });
  return out;
};

// ---------------------------------------------------------------------------
// Ports & power

const plannedPorts: Rule = ({ m }) => {
  const out: Finding[] = [];
  for (const p of m.planned) {
    const port = m.ports.find((x) => x.name === p.port);
    if (!port) continue;
    if (p.kind === "ap" && port.poe === "off")
      out.push({
        id: `planned-poe-${p.id}`,
        severity: "suggestion",
        category: "hardware",
        title: `PoE is off on ${port.name}, where ${p.name} is planned`,
        summary: `${p.name} would need its own power adapter on ${port.name}${port.comment ? ` (“${port.comment}”)` : ""}. Turn PoE on for that port before plugging it in.`,
        fix: { where: "router", cli: `/interface ethernet set ${port.name} poe-out=auto-on comment="${p.name}"` },
      });
  }
  return out;
};

const hwOffload: Rule = ({ m }) => {
  const lanPorts = m.ports.filter((p) => p.zone === "lan" && p.bridge);
  if (!lanPorts.length) return undefined;
  const off = lanPorts.filter((p) => p.hwOffload === false);
  if (off.length) return { id: "hw-offload-off", severity: "suggestion", category: "hardware", title: "Some LAN ports switch in software", summary: `${off.map((p) => p.name).join(", ")} have hardware offload off, so traffic between them goes through the CPU.`, fix: { where: "router", cli: off.map((p) => `/interface bridge port set [find interface=${p.name}] hw=yes`).join("\n") } };
  return { id: "hw-offload", severity: "pass", category: "hardware", title: "LAN ports switch in hardware", summary: "Traffic between LAN ports stays in the switch chip and does not load the CPU." };
};

const linkSpeeds: Rule = ({ m }) => {
  const slow = m.ports.filter((p) => p.speedMbps !== undefined && p.speedMbps < 1000 && p.deviceIds.length);
  return slow.map((p) => ({
    id: `port-slow-${p.name}`,
    severity: "suggestion" as const,
    category: "hardware" as const,
    title: `${p.name} links at only ${p.speedMbps} Mbps`,
    summary: `${join(names(p.deviceIds.map((id) => m.devices.find((d) => d.id === id))))} connect${p.deviceIds.length === 1 ? "s" : ""} at ${p.speedMbps} Mbps. A damaged cable or a two-pair cable usually causes this.`,
  }));
};

const RULES: Rule[] = [
  doubleNat,
  upstreamDevices,
  singleDns,
  routerDns,
  privateMacReservations,
  fiveGhzPlan,
  capVersions,
  tempRules,
  usbSharing,
  band24Clients,
  weakClients,
  duplicateSsids,
  wpa2Only,
  roaming,
  services,
  sshForwarding,
  segmentation,
  identity,
  backups,
  updateChannels,
  plannedPorts,
  linkSpeeds,
  unboundReservations,
  legacyCompat,
  leftovers,
  poolCheck,
  band24Plan,
  wifiBasics,
  firewallDefaults,
  lanOnlyTools,
  ntp,
  hwOffload,
];

export const isPrivate = isPrivateMac;
export type { Radio };
