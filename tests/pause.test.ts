// Pausing a device's internet: the rules, where they go, the check after, and the undo.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { buildModel } from "../src/core/model.ts";
import { applyPause, ChangeFailed, IPV4_FILTER, IPV6_FILTER, parsePauseComment, pauseComment, PauseRefused, planPause, resumeDevice, type RouterWrites } from "../src/core/pause.ts";
import type { RosRecord, Snapshot } from "../src/core/ros.ts";
import { getNetwork } from "../src/server/provider.ts";
import { pause, pausePreview, resume } from "../src/server/pause.ts";

const DEMO = resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json");
const { config, base } = readConfig(DEMO);
const snap = snapshotFromFiles(config, base);
const m = buildModel(snap);
const TV = "mac:00:00:5E:00:53:30";
const NOW = new Date(Date.UTC(2026, 10, 7, 14, 32));

const numbered = (rows: RosRecord[]) => rows.map((r, i) => ({ ".id": `*${(i + 1).toString(16).toUpperCase()}`, ...r }));
const FILTER = numbered([{ chain: "forward", action: "fasttrack-connection", "connection-state": "established,related", dynamic: "true", comment: "special dummy rule to show fasttrack counters" }, ...snap.devices[0]!.config.menus[IPV4_FILTER]!]);

/** A router in memory, with knobs for the ways a real one can surprise. */
function fakeRouter(opt: { ipv6?: boolean; ignorePlace?: boolean; refuse?: (rule: RosRecord) => boolean; stuck?: boolean } = {}) {
  const tables: Record<string, RosRecord[]> = { [IPV4_FILTER]: structuredClone(FILTER), ...(opt.ipv6 ? { [IPV6_FILTER]: numbered([{ chain: "forward", action: "accept", "connection-state": "established,related" }]) } : {}) };
  let next = 0x100;
  const ended: string[] = [];
  const at = (p: string, id: string) => tables[p]!.findIndex((r) => r[".id"] === id);
  const w: RouterWrites = {
    list: async (p) => tables[p]?.map((r) => ({ ...r })),
    async add(p, rule, before) {
      if (opt.refuse?.(rule)) throw new Error("HTTP 400: Bad Request: input does not match any value of interface");
      const row = { ".id": `*${(next++).toString(16).toUpperCase()}`, ...rule };
      const i = before && !opt.ignorePlace ? at(p, before) : -1;
      tables[p]!.splice(i < 0 ? tables[p]!.length : i, 0, row);
      return row[".id"];
    },
    async move(p, id, before) {
      if (opt.stuck) return;
      const [row] = tables[p]!.splice(at(p, id), 1);
      tables[p]!.splice(at(p, before), 0, row!);
    },
    async remove(p, id) {
      const i = at(p, id);
      if (i >= 0) tables[p]!.splice(i, 1);
    },
    connections: async () => snap.devices[0]!.state!["/ip/firewall/connection"]!,
    async endConnection(id) {
      ended.push(id);
    },
  };
  return { w, tables, ended };
}

const tablesOf = (f: ReturnType<typeof fakeRouter>) => ({ [IPV4_FILTER]: f.tables[IPV4_FILTER], [IPV6_FILTER]: f.tables[IPV6_FILTER] });

describe("the plan", () => {
  it("drops the device's traffic to and from the internet port, by MAC and by address", () => {
    const f = fakeRouter();
    const plan = planPause(m, TV, { now: NOW, tables: tablesOf(f) });
    const wan = m.wan.iface!;
    expect(plan.rules.map((r) => r.rule)).toEqual([
      { chain: "forward", action: "drop", "src-mac-address": "00:00:5E:00:53:30", "out-interface": wan, comment: expect.stringMatching(/^Stribog pause 00:00:5E:00:53:30 since 2026-11-07T14:32Z: /) },
      { chain: "forward", action: "drop", "in-interface": wan, "dst-address": "192.168.50.30", comment: expect.any(String) },
    ]);
    // Before the first rule the router lets you place before: not the dynamic counter rule.
    expect(plan.commands[0]).toMatch(/^\/ip firewall filter add chain=forward action=drop src-mac-address=00:00:5E:00:53:30 .* place-before=\*2$/);
    expect(plan.undo).toEqual(['/ip firewall filter remove [find where comment~"^Stribog pause 00:00:5E:00:53:30"]']);
  });

  it("covers IPv6 when the router has it", () => {
    const plan = planPause(m, TV, { now: NOW, tables: tablesOf(fakeRouter({ ipv6: true })) });
    expect(plan.rules.filter((r) => r.path === IPV6_FILTER)).toHaveLength(1);
    expect(plan.undo).toHaveLength(2);
  });

  it("refuses the router and the access points", () => {
    const ap = m.devices.find((d) => d.kind === "ap" && d.managed)!;
    expect(() => planPause(m, m.routerId!, { now: NOW, tables: {} })).toThrow(PauseRefused);
    expect(() => planPause(m, ap.id, { now: NOW, tables: {} })).toThrow(/access point/);
  });

  it("finds its own rules again by comment", () => {
    expect(parsePauseComment(pauseComment("00:00:5e:00:53:30", 'TV "living"', NOW))).toEqual({ mac: "00:00:5E:00:53:30", since: "2026-11-07T14:32Z", name: "TV living" });
    expect(parsePauseComment("defconf: fasttrack")).toBeUndefined();
  });
});

describe("applying it", () => {
  it("puts the rules before the fasttrack rule, checks them, and ends the device's open connections", async () => {
    const f = fakeRouter();
    const plan = planPause(m, TV, { now: NOW, tables: tablesOf(f) });
    const r = await applyPause(f.w, plan);
    expect(r.ok).toBe(true);
    const t = f.tables[IPV4_FILTER]!;
    const fasttrack = t.findIndex((x) => x.action === "fasttrack-connection" && x.dynamic !== "true");
    expect(t.findIndex((x) => x["src-mac-address"] === "00:00:5E:00:53:30")).toBeLessThan(fasttrack);
    expect(f.ended).toEqual(["*9"]);
    expect(r.steps.map((s) => s.text).join("\n")).toMatch(/Read back from the router: 2 rules/);
    // The model sees it from the rules alone.
    const after = buildModel(withFilter(snap, t));
    expect(after.devices.find((d) => d.id === TV)?.paused).toEqual({ since: "2026-11-07T14:32Z" });
  });

  it("moves a rule the router put at the end", async () => {
    const f = fakeRouter({ ignorePlace: true });
    const r = await applyPause(f.w, planPause(m, TV, { now: NOW, tables: tablesOf(f) }));
    expect(r.ok).toBe(true);
    expect(f.tables[IPV4_FILTER]![1]!.comment).toMatch(/^Stribog pause/);
  });

  it("takes everything back when a rule does not check out or is refused", async () => {
    for (const f of [fakeRouter({ ignorePlace: true, stuck: true }), fakeRouter({ refuse: (r) => !!r["dst-address"] })]) {
      const err = await applyPause(f.w, planPause(m, TV, { now: NOW, tables: tablesOf(f) })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChangeFailed);
      expect((err as ChangeFailed).steps.at(-1)!.text).toMatch(/as it was/);
      expect(f.tables[IPV4_FILTER]).toEqual(FILTER);
      expect(f.ended).toEqual([]);
    }
  });

  it("resumes: removes its rules from both tables and checks none are left", async () => {
    const f = fakeRouter({ ipv6: true });
    await applyPause(f.w, planPause(m, TV, { now: NOW, tables: tablesOf(f) }));
    const r = await resumeDevice(f.w, ["00:00:5E:00:53:30"]);
    expect(r.ok).toBe(true);
    expect(f.tables[IPV4_FILTER]).toEqual(FILTER);
    expect(f.tables[IPV6_FILTER]!.some((x) => x.comment)).toBe(false);
  });
});

describe("the demo", () => {
  it("pauses and resumes in memory, and the network shows it", async () => {
    const session = { id: "t", kind: "demo" as const, seenAt: Date.now() };
    expect((await pausePreview(session, TV)).rules).toHaveLength(2);
    expect((await pause(session, TV)).ok).toBe(true);
    expect((await getNetwork(session, true)).model.devices.find((d) => d.id === TV)?.paused).toBeTruthy();
    expect((await resume(session, TV)).ok).toBe(true);
    expect((await getNetwork(session, true)).model.devices.find((d) => d.id === TV)?.paused).toBeUndefined();
  });

  it("needs a router to change", async () => {
    await expect(pause(undefined, TV)).rejects.toThrow(/Sign in/);
  });
});

function withFilter(s: Snapshot, filter: RosRecord[]): Snapshot {
  const [router, ...rest] = s.devices;
  return { ...s, devices: [{ ...router!, config: { ...router!.config, menus: { ...router!.config.menus, [IPV4_FILTER]: filter } } }, ...rest] };
}
