// Pausing a device's internet on the router the person is signed in to (or the demo's, in memory).
// The rules and the checks are in core/pause.ts; this connects them to a session.

import { NotFoundError, RouterOsRest } from "../core/rest.ts";
import { applyPause, cannotPause, IPV4_FILTER, IPV6_FILTER, PauseRefused, planPause, resumeCommands, resumeDevice, type ChangeResult, type PausePlan, type RouterWrites } from "../core/pause.ts";
import type { RosRecord } from "../core/ros.ts";
import { connectionsOf } from "../core/model.ts";
import { normMac } from "../core/net.ts";
import { demoMenu, demoState, getNetwork, notesFor, routerChanged } from "./provider.ts";
import type { Session } from "./session.ts";

const gone = (e: unknown) => {
  if (!(e instanceof NotFoundError)) throw e;
};

function restWrites(rest: RouterOsRest): RouterWrites {
  return {
    list: (path) => rest.list(path),
    async add(path, rule, before) {
      const [row] = await rest.write("PUT", path, { ...rule, ...(before ? { "place-before": before } : {}) });
      if (!row?.[".id"]) throw new Error("the router did not say which rule it added");
      return row[".id"];
    },
    async move(path, id, before) {
      await rest.write("POST", `${path}/move`, { numbers: id, destination: before });
    },
    async remove(path, id) {
      await rest.write("DELETE", `${path}/${id}`).catch(gone);
    },
    connections: () => rest.connections(),
    async endConnection(id) {
      await rest.write("DELETE", `/ip/firewall/connection/${id}`).catch(gone);
    },
  };
}

/** The demo's router: its filter table in memory (no IPv6), its connection table left as it is. */
function demoWrites(): RouterWrites {
  const tables: Record<string, RosRecord[]> = {};
  const table = (path: string) => {
    if (path !== IPV4_FILTER) return undefined;
    // Exports carry no .id; number them as the router would.
    return (tables[path] ??= (demoMenu(path) ?? []).map((r, i) => ({ ".id": r[".id"] ?? `*${(i + 1).toString(16).toUpperCase()}`, ...r })));
  };
  const at = (path: string, id: string) => table(path)!.findIndex((r) => r[".id"] === id);
  return {
    list: async (path) => table(path)?.map((r) => ({ ...r })),
    async add(path, rule, before) {
      const t = table(path);
      if (!t) throw new Error(`no ${path} menu`);
      const next = Math.max(0xff, ...t.map((r) => parseInt((r[".id"] ?? "*0").slice(1), 16) || 0)) + 1;
      const row = { ".id": `*${next.toString(16).toUpperCase()}`, ...rule };
      const i = before ? at(path, before) : -1;
      t.splice(i < 0 ? t.length : i, 0, row);
      return row[".id"];
    },
    async move(path, id, before) {
      const t = table(path)!;
      const [row] = t.splice(at(path, id), 1);
      t.splice(at(path, before), 0, row!);
    },
    async remove(path, id) {
      const i = at(path, id);
      if (i >= 0) table(path)!.splice(i, 1);
    },
    connections: async () => demoState()?.["/ip/firewall/connection"] ?? [],
    async endConnection() {
      // The demo's connection table is a fixed picture.
    },
  };
}

function writesFor(session: Session): RouterWrites {
  if (session.kind === "demo") return demoWrites();
  const r = session.router!;
  return restWrites(new RouterOsRest({ url: r.url, user: r.user, password: r.password, insecure: r.encrypted, timeoutMs: 15_000 }));
}

/** Only one change at a time per router. */
let running: Promise<unknown> | undefined;
async function oneAtATime<T>(f: () => Promise<T>): Promise<T> {
  while (running) await running.catch(() => {});
  const p = f();
  running = p;
  try {
    return await p;
  } finally {
    if (running === p) running = undefined;
  }
}

export class CannotChange extends Error {}

function check(session: Session | undefined): asserts session is Session {
  if (!session || (session.kind !== "demo" && !session.router)) throw new CannotChange("Sign in to the router to change it.");
}

async function deviceOf(session: Session, id: string) {
  const p = await getNetwork(session, true);
  const d = p.model.devices.find((x) => x.id === id);
  if (!d) throw new PauseRefused("No such device.");
  return { p, d };
}

/** What pausing would add, read against the router's tables as they are now. */
export async function pausePreview(session: Session | undefined, id: string, viewerIp?: string): Promise<PausePlan> {
  check(session);
  const { p, d } = await deviceOf(session, id);
  const no = cannotPause(p.model, d);
  if (no) throw new PauseRefused(no);
  const w = writesFor(session);
  const [ip, ip6] = await Promise.all([w.list(IPV4_FILTER), w.list(IPV6_FILTER).catch(() => undefined)]);
  return planPause(p.model, id, { now: new Date(), tables: { [IPV4_FILTER]: ip ?? [], [IPV6_FILTER]: ip6 }, viewerIp });
}

export async function pause(session: Session | undefined, id: string, viewerIp?: string): Promise<ChangeResult> {
  check(session);
  return oneAtATime(async () => {
    const plan = await pausePreview(session, id, viewerIp);
    const result = await applyPause(writesFor(session), plan);
    routerChanged(session, result.tables);
    notesFor(session.kind === "demo").logChange(`device:${plan.macs[0]}`, { internet: "on" }, { internet: "paused" });
    return result;
  });
}

/** What resuming removes: every pause rule of the device's MACs. */
export async function resumePreview(session: Session | undefined, id: string): Promise<{ name: string; macs: string[]; commands: string[] }> {
  check(session);
  const { d } = await deviceOf(session, id);
  const macs = [...new Set(connectionsOf(d).map((l) => normMac(l.mac)))];
  const ip6 = await writesFor(session).list(IPV6_FILTER).catch(() => undefined);
  return { name: d.name, macs, commands: resumeCommands(macs, !!ip6) };
}

export async function resume(session: Session | undefined, id: string): Promise<ChangeResult> {
  check(session);
  return oneAtATime(async () => {
    const { macs } = await resumePreview(session, id);
    const result = await resumeDevice(writesFor(session), macs);
    routerChanged(session, result.tables);
    notesFor(session.kind === "demo").logChange(`device:${macs[0]}`, { internet: "paused" }, { internet: "on" });
    return result;
  });
}
