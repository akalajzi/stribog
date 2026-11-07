// Configuration changes with a timed undo, on the router the person is signed in to (or the
// demo's, in memory): Wi-Fi name, password and security so far. The flow is in core/undo.ts.
//
// Each change waits to be kept. The router undoes it by itself when the time is up; Stribog also
// runs the undo shortly after, in case the router's own timer did not work. Passwords pass
// through to the router and are never kept, logged or sent back.

import { randomBytes } from "node:crypto";
import { ChangeFailed, type Step } from "../core/pause.ts";
import { NotFoundError, RouterOsRest } from "../core/rest.ts";
import type { RosRecord } from "../core/ros.ts";
import { applyWithUndo, copyName, keepChange, UNDO_PREFIX, undoChange, undoScript, type ConfigWrites, type UndoStep } from "../core/undo.ts";
import { planWifiEdit, WIFI_TABLES, type WifiEdit, type WifiPlan } from "../core/wifi-setup.ts";
import { demoMenu, getNetwork, notesFor, routerChanged, setDemoMenus } from "./provider.ts";
import { CannotChange } from "./pause.ts";
import { isAlive, type Session } from "./session.ts";

const SCHEDULER = "/system/scheduler";

function restWrites(rest: RouterOsRest): ConfigWrites {
  const scheduler = async (token: string) => (await rest.list(SCHEDULER))?.find((r) => r.name === UNDO_PREFIX + token);
  return {
    list: (path) => rest.list(path),
    async set(path, id, props) {
      await rest.write("PATCH", `${path}/${id}`, props);
    },
    async armUndo(token, steps, seconds) {
      // Secrets stay on the router: the undo copies them back from a copy of the item.
      for (const [i, s] of steps.entries()) {
        if (!s.secret.length) continue;
        const row = (await rest.list(s.path))?.find((r) => r.name === s.name);
        if (!row?.[".id"]) throw new Error(`${s.name} is not on the router`);
        await rest.write("PUT", s.path, { "copy-from": row[".id"], name: copyName(token, i) });
      }
      await rest.write("PUT", SCHEDULER, {
        name: UNDO_PREFIX + token,
        interval: `${seconds}s`,
        "on-event": undoScript(token, steps),
        policy: "read,write,policy,test,sensitive",
        comment: "Stribog: puts the old settings back unless the change is kept",
      });
    },
    async undoPending(token) {
      return !!(await scheduler(token));
    },
    async disarmUndo(token, steps) {
      const s = await scheduler(token);
      if (s?.[".id"]) await rest.write("DELETE", `${SCHEDULER}/${s[".id"]}`).catch(gone);
      for (const path of [...new Set(steps.filter((x) => x.secret.length).map((x) => x.path))])
        for (const r of (await rest.list(path)) ?? []) if (r.name?.startsWith(`${UNDO_PREFIX}${token}-`) && r[".id"]) await rest.write("DELETE", `${path}/${r[".id"]}`).catch(gone);
    },
    async runUndo(token) {
      const s = await scheduler(token);
      if (!s) return;
      try {
        await rest.write("POST", "/execute", { script: s["on-event"] ?? "", "as-string": "" });
      } catch {
        // Older REST without /execute: let the scheduler run it now.
        await rest.write("PATCH", `${SCHEDULER}/${s[".id"]}`, { interval: "1s" });
      }
      for (let i = 0; i < 10 && (await scheduler(token)); i++) await new Promise((r) => setTimeout(r, 500));
    },
  };
}

const gone = (e: unknown) => {
  if (!(e instanceof NotFoundError)) throw e;
};

/** The demo's router in memory: its Wi-Fi tables, and an undo that is a timer. */
const demoUndo = new Map<string, { rows: Record<string, RosRecord[]>; timer: ReturnType<typeof setTimeout> }>();
function demoWrites(): ConfigWrites {
  // Exports carry no .id; number them as the router would. Saved back with their ids.
  const table = (path: string) => (demoMenu(path) ?? []).map((r, i) => ({ ".id": r[".id"] ?? `*${(i + 1).toString(16).toUpperCase()}`, ...r }));
  const restore = (token: string) => {
    const u = demoUndo.get(token);
    if (!u) return;
    clearTimeout(u.timer);
    setDemoMenus(u.rows);
    demoUndo.delete(token);
  };
  return {
    list: async (path) => (WIFI_TABLES.includes(path) ? table(path) : undefined),
    async set(path, id, props) {
      const rows = table(path);
      const r = rows.find((x) => x[".id"] === id);
      if (!r) throw new NotFoundError("no such item");
      // The demo never holds a real password: it keeps the router's way of hiding one.
      Object.assign(r, Object.fromEntries(Object.entries(props).map(([k, v]) => [k, /passphrase$/.test(k) ? "<hidden>" : v])));
      setDemoMenus({ [path]: rows });
    },
    async armUndo(token, steps, seconds) {
      const rows = Object.fromEntries([...new Set(steps.map((s) => s.path))].map((p) => [p, table(p)]));
      demoUndo.set(token, { rows, timer: setTimeout(() => restore(token), seconds * 1000) });
    },
    undoPending: async (token) => demoUndo.has(token),
    async disarmUndo(token) {
      clearTimeout(demoUndo.get(token)?.timer);
      demoUndo.delete(token);
    },
    async runUndo(token) {
      restore(token);
    },
  };
}

function writesFor(session: Session): ConfigWrites {
  if (session.kind === "demo") return demoWrites();
  const r = session.router!;
  return restWrites(new RouterOsRest({ url: r.url, user: r.user, password: r.password, insecure: r.encrypted, timeoutMs: 15_000 }));
}

function check(session: Session | undefined): asserts session is Session {
  if (!session || (session.kind !== "demo" && !session.router)) throw new CannotChange("Sign in to the router to change it.");
}

// ---- changes waiting to be kept ---------------------------------------------------

export interface PendingInfo {
  token: string;
  title: string;
  summary: string[];
  deadline: number;
}

interface Pending extends PendingInfo {
  session: Session;
  undo: UndoStep[];
  log: { target: string; summary: string[] };
  backstop: ReturnType<typeof setTimeout>;
}

const G = globalThis as { __stribogPending?: Map<string, Pending> };
const pending = (G.__stribogPending ??= new Map());

export function pendingChanges(session: Session | undefined): PendingInfo[] {
  if (!session) return [];
  return [...pending.values()].filter((p) => (p.session.kind === "demo") === (session.kind === "demo")).map(({ token, title, summary, deadline }) => ({ token, title, summary, deadline }));
}

async function settle(p: Pending, outcome: "kept" | "undone") {
  clearTimeout(p.backstop);
  pending.delete(p.token);
  const w = writesFor(p.session);
  const tables = Object.fromEntries(await Promise.all(WIFI_TABLES.map(async (t) => [t, ((await w.list(t).catch(() => undefined)) ?? []).filter((r) => !r.name?.startsWith(UNDO_PREFIX))] as const)));
  if (p.session.kind !== "demo") routerChanged(p.session, tables);
  notesFor(p.session.kind === "demo").logChange(p.log.target, null, { change: p.log.summary.join(" "), outcome });
}

// ---- Wi-Fi ----------------------------------------------------------------------

async function wifiPlan(session: Session, edit: WifiEdit): Promise<WifiPlan> {
  const w = writesFor(session);
  const tables = Object.fromEntries(await Promise.all(WIFI_TABLES.map(async (t) => [t, await w.list(t)] as const)));
  const others = (await getNetwork(session)).model.ssids.map((s) => s.name).filter((n) => n !== edit.ssid);
  return planWifiEdit(tables, edit, others);
}

/** What a Wi-Fi change would do, without the password. */
export async function wifiPreview(session: Session | undefined, edit: WifiEdit) {
  check(session);
  const { summary, lines, notes, undoSeconds } = await wifiPlan(session, edit);
  return { summary, lines, notes, undoSeconds };
}

let busy = false;
export async function wifiApply(session: Session | undefined, edit: WifiEdit): Promise<{ steps: Step[]; pending: PendingInfo }> {
  check(session);
  if (busy || pendingChanges(session).length) throw new CannotChange("Another change is waiting to be kept or undone first.");
  busy = true;
  try {
    const plan = await wifiPlan(session, edit);
    const token = randomBytes(4).toString("hex");
    const w = writesFor(session);
    const r = await applyWithUndo(w, plan.changes, { token, seconds: plan.undoSeconds });
    routerChanged(session, r.tables);
    const steps = r.steps;
    const info: PendingInfo = { token, title: `Wi-Fi “${edit.ssid}”`, summary: plan.summary, deadline: r.deadline };
    const p: Pending = {
      ...info,
      session,
      undo: r.undo,
      log: { target: `wifi:${edit.ssid}`, summary: plan.summary },
      // Should the router's own timer not have run, Stribog runs the undo itself.
      backstop: setTimeout(() => void backstop(token), plan.undoSeconds * 1000 + 20_000),
    };
    pending.set(token, p);
    return { steps, pending: info };
  } finally {
    busy = false;
  }
}

async function backstop(token: string) {
  const p = pending.get(token);
  if (!p) return;
  if (p.session.kind !== "demo" && !isAlive(p.session)) {
    // Signed out: the router's own timer is all there is; forget it here.
    pending.delete(token);
    return;
  }
  try {
    await undoChange(writesFor(p.session), token);
  } catch {
    // Reported by the router's log; the next read shows the state.
  }
  await settle(p, "undone").catch(() => {});
}

export async function keep(session: Session | undefined, token: string): Promise<Step[]> {
  check(session);
  const p = pending.get(token);
  if (!p) throw new CannotChange("No such change is waiting.");
  try {
    const steps = await keepChange(writesFor(session), token, p.undo);
    await settle(p, "kept");
    return steps;
  } catch (e) {
    if (e instanceof ChangeFailed && /Too late/.test(e.message)) await settle(p, "undone");
    throw e;
  }
}

export async function undo(session: Session | undefined, token: string): Promise<Step[]> {
  check(session);
  const p = pending.get(token);
  if (!p) throw new CannotChange("No such change is waiting.");
  const steps = await undoChange(writesFor(session), token);
  await settle(p, "undone");
  return steps;
}
