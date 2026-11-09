// Is the internet working, and when it is not, where does it stop? Once a minute the router
// pings its provider's gateway and two public addresses. Which of them answer says where a
// fault is: the router's own link, the provider's box, or the provider's network beyond it.
// Minutes that fail in a row add up to outages.

import type { RosRecord } from "./ros.ts";

/**
 * Cloudflare's and Google's public DNS addresses: anycast, so close to every network, and they
 * answer pings. Two, so one of them having a bad minute does not read as an outage.
 */
export const PUBLIC_TARGETS = ["1.1.1.1", "8.8.8.8"];
export const PINGS = 3;

/** What a few pings to one address got back. `rtt` is the average round trip in ms. */
export interface Probe {
  sent: number;
  received: number;
  rtt?: number;
}

/**
 * - `up`: the internet answers.
 * - `unsteady`: it answers, but loses packets (calls and games stutter).
 * - `down`: nothing on the internet answers.
 * - `unread`: the router itself did not answer Stribog.
 */
export type NetState = "up" | "unsteady" | "down" | "unread";

/** Where the internet stops, when it does. */
export type Where = "link" | "address" | "gateway" | "provider" | "beyond" | "router";

/** One recorded minute, as stored. */
export interface NetSample {
  t: number;
  s: NetState;
  w?: Where;
  /** The provider's gateway: [sent, received, average ms]. */
  g?: [number, number, number | null];
  /** The public addresses together: [sent, received, average ms]. */
  n?: [number, number, number | null];
}

/** RouterOS durations ("12ms345us", "1s2ms", "453us") in milliseconds. */
export function rosMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  let ms = 0;
  let any = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(us|ms|s|m|h)/g)) {
    const n = Number(m[1]);
    ms += m[2] === "us" ? n / 1000 : m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3600_000;
    any = true;
  }
  return any ? Math.round(ms * 100) / 100 : undefined;
}

/**
 * The answer of `/ping` over REST: a row per packet, each with running totals (`sent`,
 * `received`, `avg-rtt`); lost packets come back with a `status` such as "timeout".
 */
export function pingResult(rows: RosRecord[]): Probe {
  const last = [...rows].reverse().find((r) => r.sent !== undefined && r.received !== undefined);
  if (last) {
    const received = Number(last.received) || 0;
    return { sent: Number(last.sent) || 0, received, rtt: received ? rosMs(last["avg-rtt"]) : undefined };
  }
  const ok = rows.filter((r) => r.time && !r.status).map((r) => rosMs(r.time)!);
  return { sent: rows.length, received: ok.length, rtt: ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 100) / 100 : undefined };
}

/** Several addresses as one: packets add up, the round trip is the average of those that answered. */
export function together(ps: Probe[]): Probe {
  const answered = ps.filter((p) => p.received && p.rtt !== undefined);
  return {
    sent: ps.reduce((a, p) => a + p.sent, 0),
    received: ps.reduce((a, p) => a + p.received, 0),
    rtt: answered.length ? Math.round((answered.reduce((a, p) => a + p.rtt!, 0) / answered.length) * 100) / 100 : undefined,
  };
}

/** A share of lost packets from which a minute counts as unsteady (2 of 6 pings). */
const UNSTEADY_LOSS = 0.2;

export interface JudgeInput {
  /** The WAN interface has a link (read from the router); undefined when unknown. */
  linkUp?: boolean;
  /** The WAN's address from the provider, for a DHCP WAN; null when it has none, undefined when not known. */
  address?: string | null;
  gateway?: Probe;
  /** Whether the gateway answered pings while the internet worked: some provider boxes never do. */
  gatewayAnswers?: boolean;
  targets: Probe[];
}

/** One minute: is the internet up, and if not, where does it stop. */
export function judge(o: JudgeInput): { s: NetState; w?: Where } {
  const net = together(o.targets);
  if (net.received > 0) return { s: net.sent && 1 - net.received / net.sent >= UNSTEADY_LOSS ? "unsteady" : "up" };
  if (o.linkUp === false) return { s: "down", w: "link" };
  if (o.address === null) return { s: "down", w: "address" };
  if (o.gateway?.received) return { s: "down", w: "provider" };
  if (o.gateway && o.gatewayAnswers) return { s: "down", w: "gateway" };
  return { s: "down", w: "beyond" };
}

/** A minute as stored. */
export function sampleOf(t: number, o: JudgeInput): NetSample {
  const { s, w } = judge(o);
  const net = together(o.targets);
  const tuple = (p: Probe): [number, number, number | null] => [p.sent, p.received, p.rtt ?? null];
  return { t, s, ...(w ? { w } : {}), ...(o.gateway ? { g: tuple(o.gateway) } : {}), n: tuple(net) };
}

/** What each place means, in plain words. Inferences say "probably". */
export const WHERE_TEXT: Record<Where, { short: string; long: string }> = {
  link: {
    short: "No link to the provider's box",
    long: "The router's port to the provider's box has no link: a cable is out, or the box is off.",
  },
  address: {
    short: "No address from the provider",
    long: "The router has no address from the provider. The provider's box may be restarting, or the provider is not handing one out.",
  },
  gateway: {
    short: "Probably the provider's box or line",
    long: "The provider's gateway, which normally answers, does not: probably the provider's box or the line to it.",
  },
  provider: {
    short: "Probably the provider's network",
    long: "The router reaches the provider's gateway but nothing past it: probably the provider's network, not yours.",
  },
  beyond: {
    short: "Somewhere past the router",
    long: "Nothing on the internet answers the router. The provider's gateway does not answer pings (or is not known), so it is not clear whether the provider's box or its network is at fault.",
  },
  router: {
    short: "The router did not answer",
    long: "The router did not answer Stribog. It may have been restarting or off, or the problem was between Stribog and the router.",
  },
};

export const STATE_TEXT: Record<NetState, string> = {
  up: "Up",
  unsteady: "Losing packets",
  down: "Down",
  unread: "Router not answering",
};

/** A stretch of bad minutes in a row. */
export interface Episode {
  state: Exclude<NetState, "up">;
  from: number;
  /** When the last bad minute ended. */
  to: number;
  where?: Where;
  /** Still going at the latest sample. */
  ongoing: boolean;
}

/** Samples further apart than this are not one stretch: Stribog was not recording in between. */
const GAP_STEPS = 3;

/**
 * Bad minutes in a row, newest first. A stretch ends at a good minute, a different kind of bad
 * minute, or a gap in the recording. `step` is the recording interval.
 */
export function episodes(samples: NetSample[], step = 60_000): Episode[] {
  const out: Episode[] = [];
  let cur: (Episode & { wheres: Map<Where, number> }) | undefined;
  let prev: NetSample | undefined;
  const close = () => {
    if (!cur) return;
    const { wheres, ...e } = cur;
    const where = [...wheres].sort((a, b) => b[1] - a[1])[0]?.[0];
    out.push({ ...e, ...(where ? { where } : {}) });
    cur = undefined;
  };
  for (const x of samples) {
    const gap = prev && x.t - prev.t > step * GAP_STEPS;
    if (cur && (gap || x.s !== cur.state)) close();
    if (x.s !== "up") {
      cur ??= { state: x.s, from: x.t, to: x.t + step, ongoing: false, wheres: new Map() };
      cur.to = x.t + step;
      if (x.w) cur.wheres.set(x.w, (cur.wheres.get(x.w) ?? 0) + 1);
    }
    prev = x;
  }
  if (cur) cur.ongoing = true;
  close();
  return out.reverse();
}

export interface InternetSummary {
  from: number;
  to: number;
  /** Minutes recorded, and how many of them were down, unsteady or unread. */
  minutes: { recorded: number; down: number; unsteady: number; unread: number };
  /** Round trip to the internet and to the provider's gateway, over minutes that answered (ms). */
  latency?: { median: number; p95: number };
  gatewayLatency?: { median: number; p95: number };
  /** The latest minute, when it is recent. */
  now?: NetSample;
  episodes: Episode[];
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export function summarize(samples: NetSample[], from: number, to: number, step = 60_000): InternetSummary {
  const s = samples.filter((x) => x.t >= from && x.t <= to);
  const count = (st: NetState) => s.filter((x) => x.s === st).length;
  const rtts = (k: "g" | "n") => s.flatMap((x) => (x[k]?.[2] != null && x[k]![1] > 0 ? [x[k]![2]!] : []));
  const lat = (xs: number[]) => (xs.length ? { median: quantile(xs, 0.5), p95: quantile(xs, 0.95) } : undefined);
  const last = s.at(-1);
  return {
    from,
    to,
    minutes: { recorded: s.length, down: count("down"), unsteady: count("unsteady"), unread: count("unread") },
    latency: lat(rtts("n")),
    gatewayLatency: lat(rtts("g")),
    now: last && to - last.t <= step * GAP_STEPS ? last : undefined,
    episodes: episodes(s, step),
  };
}

const RANK: Record<NetState, number> = { up: 0, unsteady: 1, unread: 2, down: 3 };

/**
 * At most `points` samples for a chart: each bucket keeps its worst minute and its slowest
 * round trips, so a short outage or spike is not averaged away.
 */
export function thin(samples: NetSample[], points = 360): NetSample[] {
  if (samples.length <= points) return samples;
  const size = Math.ceil(samples.length / points);
  const out: NetSample[] = [];
  for (let i = 0; i < samples.length; i += size) {
    const b = samples.slice(i, i + size);
    const worst = b.reduce((a, x) => (RANK[x.s] > RANK[a.s] ? x : a), b[0]!);
    const slowest = (k: "g" | "n") => {
      const xs = b.flatMap((x) => (x[k] ? [x[k]!] : []));
      if (!xs.length) return undefined;
      const rtt = xs.reduce<number | null>((a, x) => (x[2] !== null && (a === null || x[2] > a) ? x[2] : a), null);
      return [xs.reduce((a, x) => a + x[0], 0), xs.reduce((a, x) => a + x[1], 0), rtt] as [number, number, number | null];
    };
    const g = slowest("g");
    const n = slowest("n");
    out.push({ t: b[0]!.t, s: worst.s, ...(worst.w ? { w: worst.w } : {}), ...(g ? { g } : {}), ...(n ? { n } : {}) });
  }
  return out;
}
