// Changing Wi-Fi with a timed undo: where the settings live, the change, keep and undo.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { ChangeFailed } from "../src/core/pause.ts";
import type { RosRecord } from "../src/core/ros.ts";
import { applyWithUndo, keepChange, undoChange, undoScript, type ConfigWrites, type UndoStep } from "../src/core/undo.ts";
import { CONF, IFACE, planWifiEdit, SEC, WifiRefused, wifiParts } from "../src/core/wifi-setup.ts";
import { getNetwork } from "../src/server/provider.ts";
import { keep, pendingChanges, undo, wifiApply, wifiPreview } from "../src/server/changes.ts";

const DEMO = resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json");
const { config, base } = readConfig(DEMO);
const menus = snapshotFromFiles(config, base).devices[0]!.config.menus;
const numbered = (rows: RosRecord[]): RosRecord[] => rows.map((r, i) => ({ ".id": `*${(i + 1).toString(16).toUpperCase()}`, ...r }));
const TABLES = () => {
  const t = { [CONF]: numbered(menus[CONF]!), [SEC]: numbered(menus[SEC]!), [IFACE]: numbered(menus[IFACE]!) };
  // The router keeps the real secret; Stribog's reads never see it.
  for (const s of t[SEC]) s.passphrase = `old secret of ${s.name}`;
  return t;
};

/** A router in memory that runs the undo the way the scheduler would. */
function fakeRouter(opt: { refuse?: string; noArm?: boolean } = {}) {
  const tables: Record<string, RosRecord[]> = TABLES();
  const armed = new Map<string, UndoStep[]>();
  const copies = new Map<string, RosRecord>();
  const hide = (r: RosRecord) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /passphrase$/.test(k) ? "<hidden>" : v]));
  const w: ConfigWrites = {
    list: async (p) => tables[p]?.map(hide),
    async set(p, id, props) {
      if (opt.refuse && Object.keys(props).includes(opt.refuse)) throw new Error("HTTP 400: Bad Request: invalid value");
      Object.assign(tables[p]!.find((r) => r[".id"] === id)!, props);
    },
    async armUndo(token, steps) {
      if (opt.noArm) throw new Error("HTTP 400: Bad Request: unknown parameter");
      steps.forEach((s, i) => s.secret.length && copies.set(`${token}-${i}`, { ...tables[s.path]!.find((r) => r.name === s.name)! }));
      armed.set(token, steps);
    },
    undoPending: async (token) => armed.has(token),
    async disarmUndo(token) {
      armed.delete(token);
    },
    async runUndo(token) {
      armed.get(token)?.forEach((s, i) => {
        const r = tables[s.path]!.find((x) => x.name === s.name)!;
        for (const [k, v] of Object.entries(s.old)) if (v === undefined) delete r[k];
        else r[k] = v;
        for (const k of s.secret) r[k] = copies.get(`${token}-${i}`)![k]!;
      });
      armed.delete(token);
    },
  };
  return { w, tables, armed };
}

describe("where a network's settings are", () => {
  it("finds the configurations by name, and the security profile they share", () => {
    const p = wifiParts(TABLES(), "Maple");
    expect(p.confs.map((c) => c.name)).toEqual(["home-2g", "home-5g"]);
    expect(p.profiles.map((s) => s.name)).toEqual(["sec-home"]);
    expect(p.security).toBe("wpa2-wpa3");
  });

  it("plans a rename and a password in one change per item, password masked", () => {
    const plan = planWifiEdit(TABLES(), { ssid: "Maple Guest", name: "Maple Visitors", password: "a much better passphrase", security: "wpa2-wpa3" });
    expect(plan.changes.map((c) => [c.name, c.set])).toEqual([
      ["guest-2g", { ssid: "Maple Visitors" }],
      ["guest-5g", { ssid: "Maple Visitors" }],
      ["sec-guest", { "authentication-types": "wpa2-psk,wpa3-psk", passphrase: "a much better passphrase" }],
    ]);
    expect(plan.lines.join("\n")).not.toContain("much better");
    expect(plan.lines[2]).toBe('/interface wifi security set [find where name="sec-guest"] authentication-types="wpa2-psk,wpa3-psk" passphrase="••••••••"');
    expect(plan.summary).toEqual(["Rename “Maple Guest” to “Maple Visitors”.", "Security: WPA2 + WPA3 instead of WPA2.", "A new password."]);
  });

  it("refuses what it should not do", () => {
    expect(() => planWifiEdit(TABLES(), { ssid: "Maple", password: "short" })).toThrow(/at least 8/);
    expect(() => planWifiEdit(TABLES(), { ssid: "Maple", name: "Maple Guest" })).not.toThrow();
    expect(() => planWifiEdit(TABLES(), { ssid: "Maple", name: "Maple Guest" }, ["Maple Guest"])).toThrow(/already a network/);
    expect(() => planWifiEdit(TABLES(), { ssid: "Maple", security: "wpa2-wpa3" })).toThrow(WifiRefused);
    expect(() => planWifiEdit(TABLES(), { ssid: "Nope", name: "x" })).toThrow(/cannot find/);
  });

  it("writes an undo that never holds the secret", () => {
    const s = undoScript("ab12", [{ path: SEC, name: "sec-home", old: { "authentication-types": "wpa2-psk" }, secret: ["passphrase"] }]);
    expect(s).toContain('/interface wifi security set [find where name="sec-home"] authentication-types="wpa2-psk" passphrase=[/interface wifi security get [find where name="stribog-undo-ab12-0"] passphrase]');
    expect(s).toContain('/system scheduler remove [find where name="stribog-undo-ab12"]');
    expect(s).not.toContain("old secret");
  });
});

describe("applying with a timed undo", () => {
  const edit = { ssid: "Maple", name: "Maple Home", password: "new and long enough", security: "wpa3" as const };

  it("arms the undo first, changes, reads back, and keeps", async () => {
    const f = fakeRouter();
    const plan = planWifiEdit(TABLES(), edit);
    const r = await applyWithUndo(f.w, plan.changes, { token: "t1", seconds: 150, now: 0 });
    expect(r.deadline).toBe(150_000);
    expect(r.steps[0]!.text).toMatch(/safety undo/);
    expect(f.tables[CONF]!.filter((c) => c.ssid === "Maple Home")).toHaveLength(2);
    expect(f.tables[SEC]!.find((s) => s.name === "sec-home")).toMatchObject({ "authentication-types": "wpa3-psk", passphrase: "new and long enough" });
    await keepChange(f.w, "t1", r.undo);
    expect(f.armed.size).toBe(0);
    await expect(keepChange(f.w, "t1", r.undo)).rejects.toThrow(/Too late/);
  });

  it("undoes: names, security and the old secret back", async () => {
    const f = fakeRouter();
    await applyWithUndo(f.w, planWifiEdit(TABLES(), edit).changes, { token: "t2", seconds: 150 });
    await undoChange(f.w, "t2");
    expect(f.tables).toEqual(TABLES());
  });

  it("changes nothing when the undo cannot be armed, and undoes at once when a change is refused", async () => {
    const a = fakeRouter({ noArm: true });
    await expect(applyWithUndo(a.w, planWifiEdit(TABLES(), edit).changes, { token: "t3", seconds: 150 })).rejects.toThrow(/nothing was changed/);
    expect(a.tables).toEqual(TABLES());
    const b = fakeRouter({ refuse: "passphrase" });
    const e = (await applyWithUndo(b.w, planWifiEdit(TABLES(), edit).changes, { token: "t4", seconds: 150 }).catch((x: unknown) => x)) as ChangeFailed;
    expect(e).toBeInstanceOf(ChangeFailed);
    expect(e.steps.map((s) => s.text).join("\n")).toMatch(/old settings are back/);
    expect(b.tables).toEqual(TABLES());
  });
});

describe("the demo", () => {
  const session = { id: "t", kind: "demo" as const, seenAt: Date.now() };
  const ssids = async () => (await getNetwork(session, true)).model.ssids.map((s) => s.name);

  it("renames, waits to be kept, and undoes", async () => {
    expect((await wifiPreview(session, { ssid: "Maple Guest", name: "Maple Visitors" })).lines).toHaveLength(2);
    const r = await wifiApply(session, { ssid: "Maple Guest", name: "Maple Visitors" });
    expect(await ssids()).toContain("Maple Visitors");
    expect(pendingChanges(session).map((p) => p.token)).toEqual([r.pending.token]);
    await expect(wifiApply(session, { ssid: "Maple", name: "Other" })).rejects.toThrow(/waiting/);
    await undo(session, r.pending.token);
    expect(await ssids()).toContain("Maple Guest");
    expect(pendingChanges(session)).toEqual([]);
  });

  it("keeps a change", async () => {
    const r = await wifiApply(session, { ssid: "Maple Guest", name: "Maple Visitors" });
    await keep(session, r.pending.token);
    expect(await ssids()).toContain("Maple Visitors");
    const back = await wifiApply(session, { ssid: "Maple Visitors", name: "Maple Guest" });
    await keep(session, back.pending.token);
  });
});
