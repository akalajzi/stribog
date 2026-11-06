// A request for advice on one review finding, written for an AI agent.
//
// Stribog's checks only diagnose. How to fix something depends on the whole network, the RouterOS
// version and what the owner wants, so the fix comes from an agent given enough context: the
// finding with its evidence, the configuration the check read, the devices involved, the owner's
// notes, and the rules for a safe change. Pure: same inputs, same text.

import type { Finding } from "./analyze.ts";
import { CATEGORY_LABEL } from "./analyze.ts";
import { KIND_LABEL, type DeviceKind } from "./classify.ts";
import { connectionsOf, type Device, type NetworkModel } from "./model.ts";
import { scrub, type Notes, type RosRecord, type Snapshot } from "./ros.ts";

/** Menus worth showing for checks that work from the model rather than reading menus themselves. */
const BY_CATEGORY: Partial<Record<Finding["category"], string[]>> = {
  wifi: ["/interface/wifi", "/interface/wifi/channel", "/interface/wifi/configuration", "/interface/wifi/security", "/interface/wifi/datapath", "/interface/wifi/capsman", "/interface/wifi/provisioning"],
  "dns-dhcp": ["/ip/pool", "/ip/dhcp-server", "/ip/dhcp-server/network", "/ip/dhcp-server/lease", "/ip/dns"],
  internet: ["/ip/dhcp-client", "/ip/address", "/ip/route", "/ip/firewall/nat", "/interface/list/member"],
  segmentation: ["/interface/bridge", "/interface/bridge/port", "/interface/bridge/vlan", "/interface/vlan", "/interface/list/member", "/ip/address", "/ip/firewall/filter"],
  hardware: ["/interface/ethernet", "/interface/bridge/port"],
};

/** Properties that only describe state, not configuration: left out to keep the text short. */
const NOISE = /^(\.|_)|^(dynamic|invalid|running|inactive|default|builtin|bound|actual-|last-|status|active-|expires-after|age)/;

const quote = (v: string) => (v === "" ? '""' : /[\s"';=\\[\]{}$]/.test(v) ? `"${v.replace(/["\\$]/g, (c) => `\\${c}`)}"` : v);

/** One menu as RouterOS-style lines, secrets hidden. */
export function menuText(path: string, rows: RosRecord[] | undefined): string {
  const head = path.replace(/\//g, " ").trim();
  if (!rows?.length) return `/${head}\n# (nothing configured; RouterOS defaults apply)`;
  const lines = rows.map((r) => {
    const rec = scrub({ ...r });
    const props = Object.entries(rec)
      .filter(([k, v]) => !NOISE.test(k) && v !== undefined && v !== "" && !(k === "disabled" && v === "false"))
      .map(([k, v]) => `${k}=${quote(String(v))}`)
      .join(" ");
    return `${rows.length === 1 && !rec.name && !rec[".id"] ? "set" : "add"} ${props}`;
  });
  return `/${head}\n${lines.join("\n")}`;
}

function deviceLine(d: Device, m: NetworkModel): string {
  const parent = d.parent ? m.devices.find((x) => x.id === d.parent)?.name : undefined;
  const conns = connectionsOf(d)
    .map((l) => [l.ip, l.mac, l.via?.kind === "wifi" ? `Wi-Fi ${l.via.band ?? ""} GHz ${l.via.signal ?? "?"} dBm` : l.via?.port ? `port ${l.via.port}` : "", l.status].filter(Boolean).join(", "))
    .join("; ");
  const kind = `${KIND_LABEL[d.kind as DeviceKind] ?? d.kind}${d.kindCertainty === "inferred" ? " (guessed)" : ""}`;
  const bits = [kind, d.vendor, d.model, d.version && `RouterOS ${d.version}`, parent && `via ${parent}`, conns, d.reserved && `reserved ${d.ip}`, d.description, d.notes && `notes: ${d.notes}`].filter(Boolean);
  return `- ${d.name}: ${bits.join(" · ")}`;
}

export interface AdviceInput {
  finding: Finding;
  model: NetworkModel;
  snap: Snapshot;
  notes?: Notes;
}

/** The request, as Markdown an agent can read in one go. */
export function adviceRequest({ finding: f, model: m, snap, notes }: AdviceInput): string {
  const router = m.devices.find((d) => d.id === m.routerId);
  const caps = snap.devices.filter((d) => d.role === "cap");
  const nameOfAp = (i: number) => {
    const id = caps[i]?.config.menus["/system/identity"]?.[0]?.name;
    return id ? `access point ${id}` : `access point ${i + 1}`;
  };
  const out: string[] = [];

  out.push(`# Advice wanted: ${f.title}`, "");
  out.push(
    "You are advising the owner of a home network built on MikroTik RouterOS. Stribog, a read-only network inspector, found the issue below with a rule-based check. Work out whether it really is a problem on this network, and if so how to fix it safely. The owner will review your answer and type or paste any commands themselves; Stribog does not change the router.",
    "",
  );

  out.push("## The finding", "");
  out.push(`- Check: \`${f.id}\` (${CATEGORY_LABEL[f.category]}, ${f.severity})`, `- What it says: ${f.summary}`);
  for (const d of f.detail ?? []) out.push(`- More: ${d}`);
  if (f.evidence?.length) out.push("- Evidence:", ...f.evidence.map((e) => `  - ${e}`));
  out.push("", "The check is a heuristic. It can be wrong, or right but not worth changing here.", "");

  out.push("## The network", "");
  out.push(`- Router: ${[router?.model ?? snap.devices.find((d) => d.role === "router")?.config.meta.model, router?.version && `RouterOS ${router.version}`, router?.name && `identity ${router.name}`].filter(Boolean).join(", ") || "unknown"}`);
  out.push(
    `- Internet: ${m.wan.type}${m.wan.address ? ` ${m.wan.address}` : ""}${m.wan.gateway ? ` via ${m.wan.gateway}` : ""}${m.wan.doubleNat === true ? " (behind another router: double NAT)" : ""}${m.wan.upstreamName ? `, upstream ${m.wan.upstreamName}` : ""}`,
  );
  for (const n of m.networks)
    out.push(
      `- Network ${n.label} (${n.role}): ${[n.cidr, n.bridge && `bridge ${n.bridge}`, n.vlan && `VLAN ${n.vlan}`, n.dhcp && `DHCP pool ${n.dhcp.pool.join(",")}, DNS ${n.dhcp.dns.join(", ")}`, n.ssids.length && `Wi-Fi ${n.ssids.join(", ")}`].filter(Boolean).join(", ")}`,
    );
  const aps = m.devices.filter((d) => d.kind === "ap" && d.managed);
  if (aps.length) out.push(`- Access points: ${aps.map((a) => `${a.name} (${[a.model, a.version && `RouterOS ${a.version}`].filter(Boolean).join(", ") || "?"})`).join("; ")}`);
  for (const s of m.ssids) out.push(`- SSID “${s.name}”: ${s.bands.join("+")} GHz, ${s.auth.join("/") || "?"}${s.ft ? ", fast roaming on" : ""}, ${s.clients} clients`);
  out.push(`- Devices: ${m.devices.length} known, ${m.devices.filter((d) => d.status === "online").length} online now`);
  out.push(`- Read at: ${m.generatedAt}${m.sampleState ? " (configuration real, live state is sample data)" : ""}`, "");

  const involved = (f.devices ?? []).map((id) => m.devices.find((d) => d.id === id)).filter((d): d is Device => !!d);
  if (involved.length) out.push("## Devices involved", "", ...involved.map((d) => deviceLine(d, m)), "");

  const owner = [notes?.site && `Network name: ${notes.site}`, notes?.notes, notes?.upstream && `Upstream: ${[notes.upstream.name, notes.upstream.model, notes.upstream.isp].filter(Boolean).join(", ")}`].filter(Boolean);
  if (owner.length) out.push("## What the owner wrote about the network", "", ...owner.map((x) => `- ${x}`), "");

  // The configuration the check read, else what its category usually involves.
  const reads = f.reads?.length ? f.reads : (BY_CATEGORY[f.category] ?? []).map((p) => `router ${p}`);
  if (reads.length) {
    out.push("## Configuration it is about", "", "As read from the devices (secrets hidden). Missing menus use RouterOS defaults.", "");
    const byWho = new Map<string, string[]>();
    for (const r of reads) {
      const [who, path] = r.split(" ") as [string, string];
      byWho.set(who, [...(byWho.get(who) ?? []), path]);
    }
    for (const [who, paths] of byWho) {
      const i = who === "router" ? -1 : Number(who.replace("ap", "")) - 1;
      const cfg = i < 0 ? snap.devices.find((d) => d.role === "router")?.config : caps[i]?.config;
      if (!cfg) continue;
      out.push(`### On the ${i < 0 ? "router" : nameOfAp(i)}`, "", "```routeros", paths.map((p) => menuText(p, cfg.menus[p])).join("\n\n"), "```", "");
    }
  }

  out.push(
    "## What to give back",
    "",
    "1. Whether this is a real problem here and how much it matters, in plain words. Say so if the evidence does not support it.",
    "2. The options, with their trade-offs for a home (cost, disruption, what could break). Recommend one.",
    `3. For the recommended option, the exact steps. For router changes, RouterOS ${router?.version ?? "7"} commands that touch only the items involved (select by name, comment or address, never a broad \`find\`). Say where each command runs (router, which access point, a device, the ISP).`,
    "4. Before and after: what to check first, a command or test that shows it worked, and how to undo it.",
    "5. Risk of losing access to the router (management, Wi-Fi, the internet), and how to avoid it. For anything risky, say to use Safe Mode (Ctrl+X in the terminal), which rolls changes back if the session drops.",
    "",
    "If you are connected to Stribog over MCP, you can look at more of the network (get_device, list_devices, get_device_activity) and record what you learn about devices with update_device_notes. Do not guess passwords or secrets; they are hidden on purpose.",
  );
  return out.join("\n");
}
