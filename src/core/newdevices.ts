// Which devices are new: first seen by Stribog after it had learned the network, and not yet
// known to anyone. A device is known once it has any note (a name, a kind, `known: true`) or a
// reservation on the router: someone has set it up. It stays new until then, however long ago
// it came, because most home networks rarely get one.

import { connectionsOf, type NetworkModel } from "./model.ts";
import type { DeviceNotes } from "./ros.ts";

/** Devices that turn up in the first week are the network's own, not new. */
export const LEARNING_DAYS = 7;

/** When Stribog first saw each connection (MAC) online, and when it started keeping track. */
export interface Seen {
  since: string;
  macs: Record<string, { first: string; last: string }>;
}

export function learnedAt(seen: Seen): number {
  return Date.parse(seen.since) + LEARNING_DAYS * 86_400_000;
}

/** Note on each device when it was first seen, and whether it is new. */
export function markNew(m: NetworkModel, seen: Seen | undefined, notes: Record<string, DeviceNotes> | undefined) {
  if (!seen) return;
  const learned = learnedAt(seen);
  for (const d of m.devices) {
    const links = connectionsOf(d);
    if (!links.length || d.managed || d.zone !== "lan") continue;
    const firsts = links.map((l) => seen.macs[l.mac]?.first).filter((t): t is string => !!t);
    if (!firsts.length) continue;
    d.firstSeen = firsts.sort()[0];
    // Every connection came after the learning week: a machine with one old connection is not new.
    const allNew = firsts.length === links.length && firsts.every((t) => Date.parse(t) > learned);
    const known = links.some((l) => l.reserved || hasNotes(notes?.[l.mac]));
    if (allNew && !known) d.isNew = true;
  }
}

function hasNotes(n: DeviceNotes | undefined): boolean {
  if (!n) return false;
  return Object.entries(n).some(([k, v]) => k !== "updatedAt" && v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length));
}

/**
 * Add what is online now to the record. The first record also takes in every device the router
 * knows of (offline ones from reservations and leases too), and starts the learning week.
 */
export function recordSeen(prev: Seen | undefined, now: number, online: string[], known: string[]): Seen {
  const at = new Date(now).toISOString();
  const seen: Seen = prev ? { since: prev.since, macs: { ...prev.macs } } : { since: at, macs: {} };
  if (!prev) for (const mac of known) seen.macs[mac] = { first: at, last: at };
  for (const mac of online) seen.macs[mac] = { first: seen.macs[mac]?.first ?? at, last: at };
  return seen;
}
