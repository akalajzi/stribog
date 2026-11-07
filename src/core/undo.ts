// Changes that could cut someone off (the Wi-Fi they are on, the way they reach the router) are
// made with a timed undo on the router itself. Before anything changes, a scheduler entry goes on
// the router that puts the old values back after a few minutes. Keeping the change removes it.
// If nobody comes back to keep it, because the change cut them off, the router undoes it on its
// own, whether or not Stribog can still reach it.
//
// Secrets are never read: an item with a secret to change is first copied on the router, and the
// undo copies the old secret back from that copy.

import { ChangeFailed, type Step } from "./pause.ts";
import type { RosRecord } from "./ros.ts";

/** One item to change: properties to set on the row with this .id. */
export interface ItemChange {
  path: string;
  id: string;
  /** The item's name: the undo finds it by name, the person reads it. */
  name: string;
  /** "security profile “sec-home”". */
  what: string;
  set: Record<string, string>;
  /** Keys in `set` whose values are secret: never shown, never read back. */
  secret?: string[];
}

/** What the undo puts back on one item. `old[k]` undefined: the property was not set. */
export interface UndoStep {
  path: string;
  name: string;
  old: Record<string, string | undefined>;
  secret: string[];
}

/** The changes a router accepts for configuration, with a timed undo. REST, or in memory. */
export interface ConfigWrites {
  list(path: string): Promise<RosRecord[] | undefined>;
  set(path: string, id: string, props: Record<string, string>): Promise<void>;
  /** Put the undo on the router, to run after `seconds` unless disarmed. */
  armUndo(token: string, steps: UndoStep[], seconds: number): Promise<void>;
  /** The undo is still waiting: not run, not removed. */
  undoPending(token: string): Promise<boolean>;
  disarmUndo(token: string, steps: UndoStep[]): Promise<void>;
  /** Run the undo now (it removes itself). */
  runUndo(token: string): Promise<void>;
}

export const UNDO_PREFIX = "stribog-undo-";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cli = (path: string) => `/${path.split("/").filter(Boolean).join(" ")}`;
export const rosStr = (v: string) => `"${v.replace(/["\\$]/g, (c) => `\\${c}`)}"`;

/** A change as terminal commands, secrets masked. */
export function changeLines(changes: ItemChange[]): string[] {
  return changes.map((c) => `${cli(c.path)} set [find where name=${rosStr(c.name)}] ${Object.entries(c.set).map(([k, v]) => `${k}=${c.secret?.includes(k) ? '"••••••••"' : rosStr(v)}`).join(" ")}`);
}

/**
 * The undo as a RouterOS script: old values back, secrets from the copies, then the copies and
 * the scheduler entry removed. `copyOf(i)` names the copy of step i.
 */
export function undoScript(token: string, steps: UndoStep[]): string {
  const lines: string[] = [];
  steps.forEach((s, i) => {
    const find = `[find where name=${rosStr(s.name)}]`;
    const sets = Object.entries(s.old)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${rosStr(v!)}`);
    const secrets = s.secret.map((k) => `${k}=[${cli(s.path)} get [find where name=${rosStr(copyName(token, i))}] ${k}]`);
    if (sets.length || secrets.length) lines.push(`${cli(s.path)} set ${find} ${[...sets, ...secrets].join(" ")}`);
    for (const [k, v] of Object.entries(s.old)) if (v === undefined) lines.push(`${cli(s.path)} unset ${find} value-name=${k}`);
  });
  for (const path of [...new Set(steps.filter((s) => s.secret.length).map((s) => s.path))]) lines.push(`${cli(path)} remove [find where name~${rosStr(`^${UNDO_PREFIX}${token}-`)}]`);
  lines.push(`:log warning ${rosStr("Stribog: a change was not kept, so the old settings are back")}`);
  lines.push(`/system scheduler remove [find where name=${rosStr(UNDO_PREFIX + token)}]`);
  return lines.join("\n");
}

export const copyName = (token: string, i: number) => `${UNDO_PREFIX}${token}-${i}`;

/** The undo for a set of changes, from the items as the router has them now. */
export function undoSteps(changes: ItemChange[], tables: Record<string, RosRecord[] | undefined>): UndoStep[] {
  return changes.map((c) => {
    const row = tables[c.path]?.find((r) => r[".id"] === c.id);
    if (!row) throw new ChangeFailed(`${c.what} is no longer on the router.`, []);
    const secret = c.secret ?? [];
    return { path: c.path, name: c.name, secret, old: Object.fromEntries(Object.keys(c.set).filter((k) => !secret.includes(k)).map((k) => [k, row[k]])) };
  });
}

export interface Applied {
  token: string;
  /** What keeping it removes again. */
  undo: UndoStep[];
  /** When the router puts the old settings back, unless kept. */
  deadline: number;
  steps: Step[];
  tables: Record<string, RosRecord[]>;
}

/**
 * Arm the undo, make the changes, read them back. Anything going wrong after the undo is armed
 * runs it at once; anything going wrong before leaves the router untouched.
 */
export async function applyWithUndo(w: ConfigWrites, changes: ItemChange[], opt: { token: string; seconds: number; now?: number }): Promise<Applied> {
  const steps: Step[] = [];
  const paths = [...new Set(changes.map((c) => c.path))];
  const before = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await w.list(p)] as const)));
  const undo = undoSteps(changes, before);

  try {
    await w.armUndo(opt.token, undo, opt.seconds);
    if (!(await w.undoPending(opt.token))) throw new Error("the router does not show it");
  } catch (e) {
    await w.disarmUndo(opt.token, undo).catch(() => {});
    throw new ChangeFailed(`Could not put the safety undo on the router (${err(e)}), so nothing was changed.`, steps);
  }
  steps.push({ text: `Put a safety undo on the router: it restores the old settings in ${Math.round(opt.seconds / 60 * 10) / 10} minutes unless you keep the change.`, ok: true });

  const back = async (why: string): Promise<never> => {
    steps.push({ text: why, ok: false });
    try {
      await w.runUndo(opt.token);
      steps.push({ text: "Ran the undo: the old settings are back.", ok: true });
    } catch (e) {
      steps.push({ text: `Could not run the undo now (${err(e)}); the router runs it by itself when the time is up.`, ok: false });
    }
    throw new ChangeFailed(why, steps);
  };

  for (const c of changes) {
    try {
      await w.set(c.path, c.id, c.set);
      steps.push({ text: `Changed ${c.what}.`, ok: true });
    } catch (e) {
      await back(`The router refused the change to ${c.what}: ${err(e)}`);
    }
  }

  // Read back what can be read; secrets the router does not show.
  const tables: Record<string, RosRecord[]> = {};
  for (const p of paths) tables[p] = (await w.list(p)) ?? [];
  for (const c of changes) {
    const row = tables[c.path]!.find((r) => r[".id"] === c.id);
    const wrong = Object.entries(c.set).find(([k, v]) => !c.secret?.includes(k) && row?.[k] !== v);
    if (!row || wrong) await back(`Read back from the router: ${c.what} ${row ? `has ${wrong![0]}=${row[wrong![0]] ?? "(not set)"}` : "is gone"}.`);
  }
  const secrets = changes.filter((c) => c.secret?.length).length;
  steps.push({ text: `Read back from the router: the changes are there${secrets ? " (the router never shows passwords, so that one is taken on trust)" : ""}.`, ok: true });
  // Copies the undo keeps of items with secrets are not part of the picture.
  for (const p of paths) tables[p] = tables[p]!.filter((r) => !r.name?.startsWith(UNDO_PREFIX));
  return { token: opt.token, undo, deadline: (opt.now ?? Date.now()) + opt.seconds * 1000, steps, tables };
}

/** Keep a change: remove the undo, check it is gone. Too late when the router already ran it. */
export async function keepChange(w: ConfigWrites, token: string, undo: UndoStep[]): Promise<Step[]> {
  if (!(await w.undoPending(token))) throw new ChangeFailed("Too late: the router already put the old settings back.", []);
  await w.disarmUndo(token, undo);
  if (await w.undoPending(token)) throw new ChangeFailed("The undo is still on the router; it will put the old settings back.", []);
  return [{ text: "Kept: the safety undo is removed from the router.", ok: true }];
}

export async function undoChange(w: ConfigWrites, token: string): Promise<Step[]> {
  if (!(await w.undoPending(token))) return [{ text: "The router already put the old settings back.", ok: true }];
  await w.runUndo(token);
  if (await w.undoPending(token)) throw new ChangeFailed("The undo did not finish on the router.", []);
  return [{ text: "Undone: the old settings are back.", ok: true }];
}
