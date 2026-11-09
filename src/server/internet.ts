// The internet check over a period: what the recorder kept, summed up for the app and agents.

import { resolve } from "node:path";
import { summarize, thin, type InternetSummary, type NetSample } from "../core/internet.ts";
import { HistoryStore } from "./history.ts";
import { DEMO_CONFIG, getNetwork, getNetworkForAgent, resolveConfigPath, setup } from "./provider.ts";
import { historyFor, recorderActive } from "./recorder.ts";
import type { Session } from "./session.ts";

export interface InternetHistory extends InternetSummary {
  /** Thinned for a chart: each point keeps the worst minute and slowest round trip of its bucket. */
  samples: NetSample[];
  /** When the internet check's recording began, as far as the files go. */
  since?: string;
  recording: boolean;
  /** The provider's gateway the router pings, when known. */
  gateway?: string;
}

const DEMO_HISTORY = resolve(import.meta.dirname, "../../fixtures/demo/history");

export async function internetHistory(o: { session?: Session; agent: boolean; hours: number }): Promise<InternetHistory | undefined> {
  const cfg = resolveConfigPath();
  const demo = o.session?.kind === "demo" || (!o.session && !o.agent && (!cfg || resolve(cfg) === DEMO_CONFIG));
  const payload = o.agent ? await getNetworkForAgent() : await getNetwork(o.session);
  if (!payload) return undefined;
  // The demo ships two days of it, ending when its data was taken.
  const store = demo ? new HistoryStore(DEMO_HISTORY) : historyFor(setup().dataDir);
  const to = demo ? Date.parse(payload.model.generatedAt.replace(" ", "T")) : Date.now();
  const from = to - o.hours * 3600_000;
  const all = store.internet(from, to);
  return {
    ...summarize(all, from, to),
    samples: thin(all),
    since: store.since("internet"),
    recording: !demo && recorderActive(),
    gateway: payload.model.wan.gateway,
  };
}
