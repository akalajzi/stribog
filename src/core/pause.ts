// Pausing a device's internet: firewall rules that drop what it sends to the internet and what
// the internet starts towards it, while it keeps the local network (DNS, printers, you looking at
// it). The first change Stribog makes to a router itself, through the one flow for changes: show
// the exact change, confirm, apply, read back to verify, undo what was added if the check fails.
//
// The rules go to the top of the forward chain, before the router's fasttrack rule, and the
// device's open connections are ended: fast-tracked packets skip the firewall, so a connection
// already open would otherwise carry on. Matching the device by MAC keeps it paused when its
// address changes. Pausing cannot lock anyone out: the router itself (input chain) and everything
// local are untouched.

import { connectionsOf, type Device, type NetworkModel } from "./model.ts";
import { normMac } from "./net.ts";
import type { RosRecord } from "./ros.ts";

export const IPV4_FILTER = "/ip/firewall/filter";
export const IPV6_FILTER = "/ipv6/firewall/filter";

/** `Stribog pause 00:00:5E:00:53:30 since 2026-11-07T14:32Z: Kid's tablet` */
const COMMENT = /^Stribog pause ((?:[0-9A-F]{2}:){5}[0-9A-F]{2})(?: since (\S+?))?(?:: (.*))?$/;

export function pauseComment(mac: string, name: string, at: Date): string {
  // Quotes and backslashes would need escaping in the terminal; a name does not need them.
  return `Stribog pause ${normMac(mac)} since ${at.toISOString().slice(0, 16)}Z: ${name.replace(/["\\$]/g, "").slice(0, 60)}`;
}

export function parsePauseComment(comment?: string): { mac: string; since?: string; name?: string } | undefined {
  const m = COMMENT.exec(comment ?? "");
  return m ? { mac: m[1]!, since: m[2], name: m[3] } : undefined;
}

/** Devices paused by Stribog, by MAC, from the IPv4 filter rules the router has. */
export function pausesIn(filter: RosRecord[]): Map<string, { since?: string }> {
  const out = new Map<string, { since?: string }>();
  for (const r of filter) {
    const p = parsePauseComment(r.comment);
    if (p && r.disabled !== "true" && !out.has(p.mac)) out.set(p.mac, { since: p.since });
  }
  return out;
}

export class PauseRefused extends Error {}

export interface RuleChange {
  path: typeof IPV4_FILTER | typeof IPV6_FILTER;
  rule: RosRecord;
  /** What the rule does, in plain words. */
  why: string;
}

export interface PausePlan {
  deviceId: string;
  name: string;
  macs: string[];
  ips: string[];
  rules: RuleChange[];
  /** The change as terminal commands, for the person to read before confirming. */
  commands: string[];
  /** How to undo it by hand, should Stribog be gone. */
  undo: string[];
  /** Things worth knowing first. */
  notes: string[];
}

const quote = (v: string) => (/^[\w.:/*!-]+$/.test(v) ? v : `"${v.replace(/["\\$]/g, (c) => `\\${c}`)}"`);
/** "/ip/firewall/filter" → "/ip firewall filter", as typed in the terminal. */
const cli = (path: string) => `/${path.split("/").filter(Boolean).join(" ")}`;
const command = (path: string, rec: RosRecord) => `${cli(path)} add ${Object.entries(rec).map(([k, v]) => `${k}=${quote(v)}`).join(" ")}`;

/** Why a device cannot be paused, or undefined when it can. */
export function cannotPause(m: NetworkModel, d: Device): string | undefined {
  if (d.id === m.routerId) return "This is the router itself.";
  if (d.managed) return "This is part of the network Stribog manages (an access point or switch): pausing it would cut off everyone behind it.";
  if (d.zone !== "lan") return "This device is on the internet side of the router, so its traffic does not pass through the router's firewall.";
  if (!connectionsOf(d).length) return "The router has no MAC address for this device.";
  if (!m.wan.iface) return "Stribog cannot tell which of the router's interfaces leads to the internet.";
  if (m.networks.find((n) => n.id === d.network)?.role === "wan") return "This device is on the router's internet side network.";
  return undefined;
}

/**
 * The rules that pause one device. `tables` are the filter tables as the router has them now
 * (IPv6 absent when the router has none): the rules go before the first rule there.
 */
export function planPause(m: NetworkModel, deviceId: string, opt: { now: Date; tables: Record<string, RosRecord[] | undefined>; viewerIp?: string }): PausePlan {
  const ipv6 = !!opt.tables[IPV6_FILTER];
  const d = m.devices.find((x) => x.id === deviceId);
  if (!d) throw new PauseRefused("No such device.");
  const no = cannotPause(m, d);
  if (no) throw new PauseRefused(no);
  const wan = m.wan.iface!;
  const links = connectionsOf(d);
  const macs = [...new Set(links.map((l) => normMac(l.mac)))];
  const ips = [...new Set(links.map((l) => l.ip).filter((ip): ip is string => !!ip))];
  const rules: RuleChange[] = [];
  for (const mac of macs) {
    const comment = pauseComment(mac, d.name, opt.now);
    rules.push({ path: IPV4_FILTER, rule: { chain: "forward", action: "drop", "src-mac-address": mac, "out-interface": wan, comment }, why: `Drop what ${mac} sends to the internet (${wan}).` });
    for (const ip of ips.filter((ip) => links.some((l) => normMac(l.mac) === mac && l.ip === ip)))
      rules.push({ path: IPV4_FILTER, rule: { chain: "forward", action: "drop", "in-interface": wan, "dst-address": ip, comment }, why: `Drop what the internet starts towards ${ip} (forwarded ports).` });
    if (ipv6) rules.push({ path: IPV6_FILTER, rule: { chain: "forward", action: "drop", "src-mac-address": mac, "out-interface": wan, comment }, why: `Drop what ${mac} sends to the internet over IPv6.` });
  }
  const notes: string[] = [];
  if (ips.length) notes.push(`Then its open connections are ended (${ips.join(", ")}), so nothing already open carries on.`);
  if (opt.viewerIp && ips.includes(opt.viewerIp)) notes.push("This is the device you are using now. It keeps the local network, so Stribog stays reachable from it.");
  if (d.status !== "online") notes.push("It is not online now; the pause applies when it comes back.");
  if (ipv6) notes.push("IPv6 connections the device already has open are not ended; new ones are blocked.");
  return {
    deviceId: d.id,
    name: d.name,
    macs,
    ips,
    rules,
    // The router numbers its rules by .id; "place-before" is the first rule there now.
    commands: rules.map((r) => {
      const before = firstStatic(opt.tables[r.path] ?? []);
      return `${command(r.path, r.rule)}${before ? ` place-before=${before}` : ""}`;
    }),
    undo: resumeCommands(macs, ipv6),
    notes,
  };
}

/** The changes a router accepts. Implemented over REST, and in memory for the demo and tests. */
export interface RouterWrites {
  /** A table's rules in order; undefined when the router has no such menu. */
  list(path: string): Promise<RosRecord[] | undefined>;
  /** Adds a rule before `before` (an .id), at the end without one. Returns the new rule's .id. */
  add(path: string, rule: RosRecord, before?: string): Promise<string>;
  move(path: string, id: string, before: string): Promise<void>;
  remove(path: string, id: string): Promise<void>;
  connections(): Promise<RosRecord[]>;
  endConnection(id: string): Promise<void>;
}

export interface Step {
  text: string;
  ok: boolean;
}

export interface ChangeResult {
  ok: boolean;
  steps: Step[];
  /** The tables as read back, to update Stribog's picture without a full read. */
  tables: Record<string, RosRecord[]>;
}

export class ChangeFailed extends Error {
  constructor(
    message: string,
    readonly steps: Step[],
  ) {
    super(message);
  }
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const firstStatic = (rows: RosRecord[]) => rows.find((r) => r.dynamic !== "true")?.[".id"];

/**
 * Where in a table a rule stops mattering for new packets of open connections: the first forward
 * rule that fast-tracks or accepts established traffic. A pause rule must come before it.
 */
function firstPass(rows: RosRecord[]): number {
  const i = rows.findIndex((r) => r.chain === "forward" && r.disabled !== "true" && r.dynamic !== "true" && (r.action === "fasttrack-connection" || (r.action === "accept" && /established/.test(r["connection-state"] ?? ""))));
  return i < 0 ? rows.length : i;
}

/** Why an added rule is not doing its job, or undefined when it is. */
function problem(rows: RosRecord[], id: string): string | undefined {
  const i = rows.findIndex((r) => r[".id"] === id);
  if (i < 0) return "it is not there";
  if (rows[i]!.disabled === "true") return "it is disabled";
  if (rows[i]!.invalid === "true") return "the router marks it invalid";
  if (i > firstPass(rows)) return "it comes after the rule that lets open connections through";
  return undefined;
}

/**
 * Add the pause rules, check them as the router reports them, end the device's open connections.
 * Anything wrong with the rules undoes all of them; a connection that cannot be ended is reported.
 */
export async function applyPause(r: RouterWrites, plan: PausePlan): Promise<ChangeResult> {
  const steps: Step[] = [];
  const added: { path: string; id: string }[] = [];
  const tables: Record<string, RosRecord[]> = {};
  const undo = async (why: string): Promise<never> => {
    for (const a of added.reverse()) {
      try {
        await r.remove(a.path, a.id);
      } catch (e) {
        steps.push({ text: `Could not remove rule ${a.id} again: ${err(e)}. Remove it by hand: ${plan.undo.join("; ")}`, ok: false });
      }
    }
    if (added.length) steps.push({ text: `Removed the ${added.length} rule${added.length === 1 ? "" : "s"} added, so the router is as it was.`, ok: true });
    throw new ChangeFailed(why, steps);
  };

  for (const path of [...new Set(plan.rules.map((x) => x.path))]) {
    const rows = await r.list(path);
    if (!rows) {
      if (path === IPV6_FILTER) continue;
      throw new ChangeFailed(`The router has no ${path} menu.`, steps);
    }
    const before = firstStatic(rows);
    for (const c of plan.rules.filter((x) => x.path === path)) {
      try {
        added.push({ path, id: await r.add(path, c.rule, before) });
        steps.push({ text: `Added: ${c.why}`, ok: true });
      } catch (e) {
        steps.push({ text: `The router refused a rule: ${err(e)}`, ok: false });
        await undo(`The router refused a rule: ${err(e)}`);
      }
    }
    // Read back: each rule there, enabled, valid, before the rule that lets open connections through.
    let back = (await r.list(path)) ?? [];
    for (const a of added.filter((x) => x.path === path)) {
      if (problem(back, a.id) === "it comes after the rule that lets open connections through" && before) {
        await r.move(path, a.id, before);
        back = (await r.list(path)) ?? [];
      }
    }
    const wrong = added.filter((x) => x.path === path).map((a) => problem(back, a.id)).find(Boolean);
    if (wrong) {
      steps.push({ text: `Read back from the router: a rule is not working, ${wrong}.`, ok: false });
      await undo(`A rule did not check out: ${wrong}.`);
    }
    const n = added.filter((x) => x.path === path).length;
    steps.push({ text: `Read back from the router: ${n} rule${n === 1 ? "" : "s"} in ${cli(path)}, enabled, before any rule that lets open connections through.`, ok: true });
    tables[path] = back;
  }

  // Open connections: their packets are fast-tracked past the firewall until the entry is gone.
  if (plan.ips.length) {
    const hostOf = (a?: string) => a?.replace(/:\d+$/, "");
    try {
      const open = (await r.connections()).filter((c) => plan.ips.includes(hostOf(c["src-address"]) ?? "") || plan.ips.includes(hostOf(c["dst-address"]) ?? ""));
      let ended = 0;
      for (const c of open) {
        if (!c[".id"]) continue;
        try {
          await r.endConnection(c[".id"]);
          ended++;
        } catch {
          // Gone by itself in the meantime.
        }
      }
      steps.push({ text: open.length ? `Ended ${ended} open connection${ended === 1 ? "" : "s"}.` : "It had no open connections.", ok: true });
    } catch (e) {
      steps.push({ text: `Could not end its open connections (${err(e)}); connections already open may carry on until they close.`, ok: false });
    }
  }
  return { ok: steps.every((s) => s.ok), steps, tables };
}

/** Remove every pause rule of the given MACs, and check they are gone. */
export async function resumeDevice(r: RouterWrites, macs: string[]): Promise<ChangeResult> {
  const steps: Step[] = [];
  const tables: Record<string, RosRecord[]> = {};
  const ours = (row: RosRecord) => macs.includes(parsePauseComment(row.comment)?.mac ?? "");
  for (const path of [IPV4_FILTER, IPV6_FILTER]) {
    const rows = await r.list(path);
    if (!rows) continue;
    const mine = rows.filter(ours);
    for (const row of mine) await r.remove(path, row[".id"]!);
    const back = (await r.list(path)) ?? [];
    if (back.some(ours)) {
      steps.push({ text: `Read back from the router: pause rules are still in ${cli(path)}.`, ok: false });
      throw new ChangeFailed(`Pause rules are still in ${path}.`, steps);
    }
    if (mine.length) steps.push({ text: `Removed ${mine.length} rule${mine.length === 1 ? "" : "s"} from ${cli(path)}; read back, none left.`, ok: true });
    tables[path] = back;
  }
  if (!steps.length) steps.push({ text: "There were no pause rules for it on the router.", ok: true });
  return { ok: true, steps, tables };
}

/** The pause rules of a device as they stand on the router, for the resume confirmation. */
export function resumeCommands(macs: string[], ipv6: boolean): string[] {
  return [IPV4_FILTER, ...(ipv6 ? [IPV6_FILTER] : [])].flatMap((p) => macs.map((mac) => `${cli(p)} remove [find where comment~"^Stribog pause ${mac}"]`));
}
