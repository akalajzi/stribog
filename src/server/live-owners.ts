// Who the whole network talks to on the internet right now: the router's connection table read
// every few seconds, what each connection moved since the last read, grouped by network owner.

import { resolve } from "node:path";
import { networkByOwner, networkByPlace, type OwnerNow, type PlaceNow } from "../core/activity.ts";
import type { NetworkModel } from "../core/model.ts";
import type { RosRecord } from "../core/ros.ts";
import { RouterOsRest } from "../core/rest.ts";
import { AsnDb, asnDb } from "./owners.ts";
import { COUNTRY_CREDIT, CountryDb, countryDb } from "./places.ts";
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
  /** The same traffic by the country of the other end, from a geolocation database. */
  places: PlaceNow[];
  /** The country database is ready; until then no traffic has a place. */
  placesKnown: boolean;
  /** The country of the router's own internet address, when it has a public one. */
  addressCountry?: string;
  /** Whose database the countries come from (its licence asks for the credit). */
  placesCredit: { text: string; url: string };
}

/**
 * Reads closer together than this reuse the last one: tabs share it, and the router is spared.
 * A big connection table (thousands of connections, a torrent client say) is read less often:
 * about 2 ms per connection, so 2,000 connections every 4 seconds, 10,000 every 20.
 */
const minMs = (connections: number) => Math.max(3000, connections * 2);

interface State {
  prev: Map<string, { orig: number; repl: number }>;
  at?: number;
  last?: OwnersNow;
  size?: number;
  running?: Promise<OwnersNow>;
}
const states = new WeakMap<Session, State>();

const DEMO_ASN = resolve(import.meta.dirname, "../../fixtures/demo/asn.tsv");
const DEMO_COUNTRIES = resolve(import.meta.dirname, "../../fixtures/demo/countries.csv");
let demoAsn: Promise<AsnDb> | undefined;
let demoCountries: Promise<CountryDb> | undefined;

/** One read's traffic, grouped by owner and by country. */
function grouped(moved: RosRecord[], seconds: number, m: NetworkModel, asn?: AsnDb, countries?: CountryDb) {
  const ownerOf = (ip: string) => asn?.lookup(ip);
  const placeOf = (ip: string) => countries?.lookup(ip);
  return {
    owners: networkByOwner(moved, seconds, m, ownerOf).slice(0, 12),
    places: networkByPlace(moved, seconds, m, placeOf, ownerOf),
  };
}

const known = (m: NetworkModel, asn?: AsnDb, countries?: CountryDb) => ({
  ownersKnown: !!asn,
  placesKnown: !!countries,
  addressCountry: m.wan.addressKind === "public" && m.wan.address ? countries?.lookup(m.wan.address) : undefined,
  placesCredit: COUNTRY_CREDIT,
});

export async function ownersNow(session: Session): Promise<OwnersNow | undefined> {
  const payload = await getNetwork(session);
  if (session.kind === "demo") {
    // The demo's connection table is a fixed picture: treat its bytes as the last minute's.
    const asn = await (demoAsn ??= AsnDb.load(DEMO_ASN));
    const countries = await (demoCountries ??= CountryDb.load(DEMO_COUNTRIES));
    const conns = demoState()?.["/ip/firewall/connection"] ?? [];
    return { at: Date.now(), seconds: 60, ...grouped(conns, 60, payload.model, asn, countries), ...known(payload.model, asn, countries) };
  }
  const r = session.router;
  if (!r) return undefined;
  const st: State = states.get(session) ?? { prev: new Map() };
  states.set(session, st);
  if (st.last && Date.now() - st.last.at < minMs(st.size ?? 0)) return st.last;
  st.running ??= (async () => {
    try {
      const conns = await new RouterOsRest({ url: r.url, user: r.user, password: r.password, insecure: r.encrypted }).connections();
      const now = Date.now();
      const seconds = st.at ? (now - st.at) / 1000 : undefined;
      const moved = deltas(conns, st.prev);
      st.size = conns.length;
      st.at = now;
      const asn = asnDb(setup().dataDir);
      const countries = countryDb(setup().dataDir);
      // The first read only sets the counters: everything a connection ever moved is not "now".
      const ok = !!seconds && seconds < 120;
      return (st.last = {
        at: now,
        seconds: ok ? Math.round(seconds * 10) / 10 : undefined,
        ...(ok ? grouped(moved, seconds, payload.model, asn, countries) : { owners: [], places: [] }),
        ...known(payload.model, asn, countries),
      });
    } finally {
      st.running = undefined;
    }
  })();
  return st.running;
}
