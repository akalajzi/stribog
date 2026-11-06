// Traffic per connection (MAC) over the last minute, from the router's connection table: what
// moved between two recorder ticks. Used where the router has no counter of a device's own
// link (wired behind an access point or a switch). Routed traffic only: what a device sends to
// another on the same LAN bridge never passes the router's connection tracking.

export interface Rates {
  at: number;
  byMac: Map<string, { downBps: number; upBps: number }>;
}

// On globalThis so Vite's module reloads in development keep the last measurement.
const G = globalThis as { __stribogRates?: Rates };

/** Fresh rates only: a measurement older than three minutes says nothing about now. */
export function ratesNow(now = Date.now()): Rates | undefined {
  const r = G.__stribogRates;
  return r && now - r.at < 3 * 60_000 ? r : undefined;
}

export function setRates(r: Rates) {
  G.__stribogRates = r;
}
