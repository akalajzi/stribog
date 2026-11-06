// Who the whole network talks to on the internet right now: the router's connection table read
// every few seconds, what each connection moved since the last read, grouped by network owner.

import { resolve } from "node:path";
import { networkByOwner, type OwnerNow } from "../core/activity.ts";
import { RouterOsRest } from "../core/rest.ts";
import { AsnDb, asnDb } from "./owners.ts";
import { demoState, getNetwork, setup } from "./provider.ts";
import { deltas } from "./recorder.ts";
import type { Session } from "./session.ts";

export interface OwnersNow {
  at: number;
  /** Seconds the rates are over; absent on the first read, which only sets the counters. */
  seconds?: number;
  owners: OwnerNow[];
  /** The owner database is ready; until then everything is "Unknown network". */
  ownersKnown: boolean;
}

/** Reads closer together than this reuse the last one: tabs share it, and the router is spared. */
const MIN_MS = 3000;

interface State {
  prev: Map<string, { orig: number; repl: number }>;
  at?: number;
  last?: OwnersNow;
  running?: Promise<OwnersNow>;
}
const states = new WeakMap<Session, State>();

const DEMO_ASN = resolve(import.meta.dirname, "../../fixtures/demo/asn.tsv");
let demoAsn: Promise<AsnDb> | undefined;

export async function ownersNow(session: Session): Promise<OwnersNow | undefined> {
  const payload = await getNetwork(session);
  if (session.kind === "demo") {
    // The demo's connection table is a fixed picture: treat its bytes as the last minute's.
    const db = await (demoAsn ??= AsnDb.load(DEMO_ASN));
    const conns = demoState()?.["/ip/firewall/connection"] ?? [];
    return { at: Date.now(), seconds: 60, owners: networkByOwner(conns, 60, payload.model, (ip) => db.lookup(ip)).slice(0, 12), ownersKnown: true };
  }
  const r = session.router;
  if (!r) return undefined;
  const st: State = states.get(session) ?? { prev: new Map() };
  states.set(session, st);
  if (st.last && Date.now() - st.last.at < MIN_MS) return st.last;
  st.running ??= (async () => {
    try {
      const conns = await new RouterOsRest({ url: r.url, user: r.user, password: r.password, insecure: r.encrypted }).connections();
      const now = Date.now();
      const seconds = st.at ? (now - st.at) / 1000 : undefined;
      const moved = deltas(conns, st.prev);
      st.at = now;
      const db = asnDb(setup().dataDir);
      // The first read only sets the counters: everything a connection ever moved is not "now".
      const owners = seconds && seconds < 120 ? networkByOwner(moved, seconds, payload.model, (ip) => db?.lookup(ip)).slice(0, 12) : [];
      return (st.last = { at: now, seconds: seconds && seconds < 120 ? Math.round(seconds * 10) / 10 : undefined, owners, ownersKnown: !!db });
    } finally {
      st.running = undefined;
    }
  })();
  return st.running;
}
