// Firewall rules in plain language.
//
// RouterOS rules are terse matchers ("chain=input in-interface-list=!LAN action=drop"). This turns
// each one into a sentence a non-expert can check against what they meant, and groups them the way
// people think about them: who may talk to the router, what may pass through it, and what gets
// translated. Pure: no I/O, no model lookups beyond the optional names passed in.

import type { FwRule } from "./model.ts";

export type FwGroup = "input" | "forward" | "nat" | "other";
export type FwVerdict = "allow" | "drop" | "nat" | "speed" | "other";

export interface FwSentence {
  rule: FwRule;
  /** Position within its RouterOS table (filter or nat), 0-based, as shown by `print`. */
  index: number;
  group: FwGroup;
  verdict: FwVerdict;
  text: string;
  /** Optional second line: why the rule exists, for the ones that are not obvious. */
  note?: string;
  isDefault: boolean;
  temporary: boolean;
  disabled: boolean;
}

export const FW_GROUP_LABEL: Record<FwGroup, string> = {
  input: "Router access",
  forward: "Traffic through the router",
  nat: "Address translation",
  other: "Other rules",
};

export const FW_GROUP_HINT: Record<FwGroup, string> = {
  input: "Connections to the router itself: its login pages, DNS, DHCP. Checked top to bottom; the first match wins.",
  forward: "Traffic passing between networks, such as the LAN going out to the internet.",
  nat: "Rewriting addresses: sharing the WAN address with the LAN, and forwarding ports to devices.",
  other: "Custom chains and rules for the router's own outgoing traffic.",
};

/** Optional friendly names, e.g. { "lan-home": "Home LAN", "192.168.1.254": "the ISP router" }. */
export type FwNames = Record<string, string>;

const PORTS: Record<string, string> = {
  "20": "FTP data",
  "21": "FTP",
  "22": "SSH",
  "23": "Telnet",
  "53": "DNS",
  "67": "DHCP",
  "68": "DHCP",
  "80": "WebFig (HTTP)",
  "123": "NTP",
  "443": "HTTPS",
  "500": "IPsec",
  "1194": "OpenVPN",
  "1701": "L2TP",
  "1723": "PPTP",
  "4500": "IPsec NAT-T",
  "5246": "CAPsMAN",
  "5247": "CAPsMAN",
  "5678": "MikroTik discovery",
  "8291": "WinBox",
  "8728": "API",
  "8729": "API-SSL",
  "51820": "WireGuard",
};

const PROTO: Record<string, string> = { icmp: "ICMP (ping)", tcp: "TCP", udp: "UDP", gre: "GRE", "ipsec-esp": "IPsec ESP", "ipsec-ah": "IPsec AH", igmp: "IGMP", icmpv6: "ICMPv6" };

const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const neg = (v: string) => v.startsWith("!");
const bare = (v: string) => v.replace(/^!/, "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const isTemporaryRule = (r: FwRule) => /\b(temp|temporary|staging)\b/i.test(r.comment ?? "");
export const isDefconfRule = (r: FwRule) => /^defconf\b/i.test(r.comment ?? "");

export function groupOf(r: FwRule, table: "filter" | "nat" = "filter"): FwGroup {
  if (table === "nat" || r.chain === "srcnat" || r.chain === "dstnat") return "nat";
  if (r.chain === "input") return "input";
  if (r.chain === "forward") return "forward";
  return "other";
}

/** "22,80,8291" + tcp → "SSH, WebFig (HTTP) and WinBox". Unknown ports keep their numbers. */
export function describePorts(ports: string | undefined, protocol?: string): string | undefined {
  if (!ports) return undefined;
  const negated = neg(ports);
  const list = bare(ports).split(",").map((p) => p.trim()).filter(Boolean);
  const named: string[] = [];
  const raw: string[] = [];
  for (const p of list) {
    const n = PORTS[p];
    if (n && !named.includes(n)) named.push(n);
    else if (!n) raw.push(p);
  }
  const proto = protocol ? (PROTO[bare(protocol)] ?? bare(protocol).toUpperCase()) : "";
  const parts = [...named];
  if (raw.length) parts.push(`${proto ? `${proto} ` : ""}port${raw.length > 1 || raw[0]!.includes("-") ? "s" : ""} ${raw.join(", ")}`);
  const s = join(parts);
  return negated ? `everything except ${s}` : s;
}

function iface(v: string, names: FwNames): string {
  const n = names[bare(v)];
  return n ? `${n} (${bare(v)})` : bare(v);
}

function listPhrase(v: string, dir: "from" | "to"): string {
  const l = bare(v);
  const what = l === "LAN" ? "the LAN" : l === "WAN" ? "the internet side (WAN)" : `the ${l} interfaces`;
  if (neg(v)) return dir === "from" ? `that does not come from ${what}` : `that is not going to ${what}`;
  return `${dir} ${what}`;
}

function addr(v: string, names: FwNames): string {
  const n = names[bare(v)];
  const a = n ? `${n} (${bare(v)})` : bare(v);
  return neg(v) ? `anything but ${a}` : a;
}

/** What the rule matches, as a noun phrase. */
function subject(r: FwRule): string {
  const cs = r["connection-state"];
  if (cs) {
    const states = bare(cs).split(",").map((s) => s.trim());
    if (states.length === 1 && states[0] === "invalid") return neg(cs) ? "valid packets" : "invalid packets";
    if (states.length === 1 && states[0] === "new") return "new connections";
    if (states.includes("established") || states.includes("related")) return "replies and related traffic of existing connections";
  }
  const ports = describePorts(r["dst-port"], r.protocol);
  if (ports) return ports;
  if (r.protocol) {
    const p = PROTO[bare(r.protocol)] ?? bare(r.protocol).toUpperCase();
    return neg(r.protocol) ? `everything except ${p}` : p === "ICMP (ping)" ? "ICMP (ping and network diagnostics)" : `${p} traffic`;
  }
  return "everything";
}

/** Where the traffic comes from and goes to. */
function scope(r: FwRule, names: FwNames, skipFrom = false): string {
  const bits: string[] = [];
  if (!skipFrom) {
    if (r["src-address"]) bits.push(`from ${addr(r["src-address"], names)}`);
    if (r["src-address-list"]) bits.push(`from addresses in the ${bare(r["src-address-list"])} list${neg(r["src-address-list"]) ? " (excluded)" : ""}`);
    if (r["in-interface-list"]) bits.push(listPhrase(r["in-interface-list"], "from"));
    if (r["in-interface"]) bits.push(`${neg(r["in-interface"]) ? "not arriving on" : "on"} ${iface(r["in-interface"], names)}`);
  }
  if (r["dst-address"] && r.chain !== "input") bits.push(`to ${addr(r["dst-address"], names)}`);
  if (r["dst-address-list"]) bits.push(`to addresses in the ${bare(r["dst-address-list"])} list`);
  if (r["out-interface-list"]) bits.push(listPhrase(r["out-interface-list"], "to"));
  if (r["out-interface"]) bits.push(`${neg(r["out-interface"]) ? "not leaving through" : "out through"} ${iface(r["out-interface"], names)}`);
  if (r["src-port"]) bits.push(`from port ${r["src-port"]}`);
  return bits.length ? " " + bits.join(" ") : "";
}

/** One rule as a sentence. `names` maps interface names and addresses to friendly labels. */
export function describeRule(r: FwRule, names: FwNames = {}): { text: string; note?: string; verdict: FwVerdict } {
  const a = r.action;
  const cs = r["connection-state"] ?? "";

  // ---- signatures of the standard (defconf) rules, worded for people -------------------
  if (r.chain === "input" && a === "accept" && /established/.test(cs))
    return { verdict: "allow", text: "Allow replies to connections the router started", note: "So the router can reach the internet for DNS, updates and time." };
  if (r.chain === "forward" && a === "accept" && /established/.test(cs) && !r["in-interface"] && !r["in-interface-list"])
    return { verdict: "allow", text: "Let replies to existing connections through", note: "Once a connection is allowed, its return traffic flows without re-checking." };
  if (a === "fasttrack-connection")
    return { verdict: "speed", text: "Fast-track established connections", note: "Speeds up ongoing downloads and streams by skipping the rest of the firewall for them." };
  if (a === "drop" && cs === "invalid") return { verdict: "drop", text: `Drop broken or out-of-sequence packets${r.chain === "input" ? " to the router" : ""}` };
  if (r.chain === "input" && a === "accept" && r["dst-address"] === "127.0.0.1" && (r["in-interface"] === "lo" || r["src-address"] === "127.0.0.1"))
    return { verdict: "allow", text: "Allow the router to talk to itself", note: "Needed when the router is both the CAPsMAN controller and an access point." };
  if (r.chain === "input" && a === "drop" && r["in-interface-list"] === "!LAN" && !r.protocol && !r["dst-port"] && !r["src-address"])
    return { verdict: "drop", text: "Drop everything to the router that does not come from the LAN", note: "The rule that keeps the router's login pages, DNS and other services away from the internet." };
  if (r.chain === "forward" && a === "drop" && r["connection-nat-state"] === "!dstnat" && r["in-interface-list"] === "WAN")
    return { verdict: "drop", text: "Drop new connections from the internet unless they are port-forwarded", note: "Nothing outside can start a connection to a LAN device on its own." };
  if (r["ipsec-policy"] && a === "accept" && r.chain === "forward") {
    const dir = r["ipsec-policy"].startsWith("in") ? "arriving through" : "leaving through";
    return { verdict: "allow", text: `Allow traffic ${dir} an IPsec VPN tunnel`, note: "Part of the default rules; harmless if you have no IPsec VPN." };
  }
  if (r.chain === "input" && a === "accept" && r.protocol === "udp" && r["dst-port"] === "68" && r["src-port"] === "67")
    return { verdict: "allow", text: `Allow DHCP replies${r["src-address"] ? ` from ${addr(r["src-address"], names)}` : ""}${r["in-interface"] ? ` on ${iface(r["in-interface"], names)}` : ""}`, note: "So the router can get its WAN address from the upstream router." };

  // ---- NAT -------------------------------------------------------------------------------
  if (a === "masquerade") {
    const out = r["out-interface-list"] ? listPhrase(r["out-interface-list"], "to") : r["out-interface"] ? `out through ${iface(r["out-interface"], names)}` : "";
    const internet = r["out-interface-list"] === "WAN";
    return {
      verdict: "nat",
      text: internet
        ? "Share the router's internet address with every device (masquerade)"
        : `Masquerade traffic${r["src-address"] ? ` from ${addr(r["src-address"], names)}` : ""}${out ? ` ${out}` : ""}`,
      note: internet ? "Devices use private addresses; on the way out they all appear as the router." : undefined,
    };
  }
  if (a === "dst-nat" || a === "netmap") {
    const target = `${r["to-addresses"] ?? "the router"}${r["to-ports"] ? `:${r["to-ports"]}` : ""}`;
    const what = r["dst-port"] ? describePorts(r["dst-port"], r.protocol) : undefined;
    const dst = r["dst-address"] ? ` for ${addr(r["dst-address"], names)}` : "";
    const from = scope({ ...r, "dst-address": undefined, "out-interface": undefined, "out-interface-list": undefined }, names);
    if (r["in-interface-list"] === "WAN" && what)
      return { verdict: "nat", text: `Forward ${what} from the internet to ${target}`, note: "A port forward: outside connections on this port reach that device." };
    return { verdict: "nat", text: `Send ${what ?? "traffic"}${dst}${from} to ${target}` };
  }
  if (a === "src-nat") {
    const from = r["src-address"] ? ` from ${addr(r["src-address"], names)}` : "";
    const to = r["dst-address"] ? ` to ${addr(r["dst-address"], names)}` : "";
    const hairpin = !!r["dst-address"] && !!r["src-address"] && r["out-interface-list"] !== "WAN";
    return {
      verdict: "nat",
      text: `Rewrite the sender of traffic${from}${to} as ${r["to-addresses"] ?? "the router"}`,
      note: hairpin ? "A hairpin rule: replies come back through the router, so redirected addresses work from inside the LAN too." : undefined,
    };
  }
  if (a === "redirect") return { verdict: "nat", text: `Redirect ${subject(r)}${scope(r, names)} to the router itself${r["to-ports"] ? ` (port ${r["to-ports"]})` : ""}` };

  // ---- generic ---------------------------------------------------------------------------
  const verb = a === "accept" ? "Allow" : a === "drop" ? "Drop" : a === "reject" ? "Reject" : a === "log" ? "Log" : a === "passthrough" ? "Count" : a === "return" ? "Return early for" : a === "jump" ? "Check" : a === "add-src-to-address-list" ? "Remember the sender of" : cap(a.replace(/-/g, " "));
  const verdict: FwVerdict = a === "accept" ? "allow" : a === "drop" || a === "reject" || a === "tarpit" ? "drop" : "other";
  let s = subject(r);
  if (r.chain === "input" && s === "everything") s = "everything to the router";
  else if (r.chain === "input") s = `${s} to the router`;
  else if (r.chain === "output") s = `${s} sent by the router`;
  let text = `${verb} ${s}${scope(r, names)}`;
  if (r["connection-nat-state"] === "!dstnat") text += " unless it is port-forwarded";
  else if (r["connection-nat-state"] === "dstnat") text += " that is port-forwarded";
  if (a === "jump" && r["jump-target"]) text += ` against the ${r["jump-target"]} rules`;
  return { verdict, text };
}

/** All rules, numbered and grouped, in router order. */
export function summarizeFirewall(fw: { filter: FwRule[]; nat: FwRule[] } | undefined, names: FwNames = {}): Record<FwGroup, FwSentence[]> {
  const out: Record<FwGroup, FwSentence[]> = { input: [], forward: [], nat: [], other: [] };
  if (!fw) return out;
  const push = (r: FwRule, index: number, table: "filter" | "nat") => {
    const d = describeRule(r, names);
    const temporary = isTemporaryRule(r);
    out[groupOf(r, table)].push({
      rule: r,
      index,
      group: groupOf(r, table),
      verdict: d.verdict,
      text: temporary ? `${d.text} (temporary)` : d.text,
      note: d.note,
      isDefault: isDefconfRule(r),
      temporary,
      disabled: !!r.disabled,
    });
  };
  fw.filter.forEach((r, i) => push(r, i, "filter"));
  fw.nat.forEach((r, i) => push(r, i, "nat"));
  return out;
}
