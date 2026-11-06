// Where the network picture comes from: files (exports + state), a saved snapshot, or a live router.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze, type Analysis } from "../core/analyze.ts";
import { layoutTopology, type Layout } from "../core/layout.ts";
import { expand, readConfig, snapshotFromFiles, type StribogConfig } from "../core/load.ts";
import { buildModel, type NetworkModel } from "../core/model.ts";
import { RouterOsRest } from "../core/rest.ts";
import type { Overrides, Snapshot } from "../core/ros.ts";

export interface NetworkPayload {
  model: NetworkModel;
  analysis: Analysis;
  layout: Layout;
  meta: { mode: "files" | "live" | "demo"; sample: boolean; error?: string; configPath: string; refreshedAt: string };
}

const ROOT = resolve(import.meta.dirname, "../..");

export function resolveConfigPath(): { path: string; demo: boolean } {
  const env = process.env.STRIBOG_CONFIG;
  if (env) return { path: expand(env), demo: false };
  const local = resolve(process.cwd(), "stribog.config.json");
  if (existsSync(local)) return { path: local, demo: false };
  return { path: resolve(ROOT, "fixtures/demo/stribog.config.json"), demo: true };
}

let cache: { at: number; payload: NetworkPayload } | undefined;

export async function getNetwork(force = false): Promise<NetworkPayload> {
  const { path, demo } = resolveConfigPath();
  const { config, base } = readConfig(path);
  const ttl = (config.live?.interval ?? 15) * 1000;
  if (!force && cache && Date.now() - cache.at < (config.live ? ttl : 2000)) return cache.payload;

  let snap: Snapshot;
  let mode: NetworkPayload["meta"]["mode"] = demo ? "demo" : "files";
  let error: string | undefined;
  try {
    if (config.live) {
      snap = await liveSnapshot(config, base);
      mode = "live";
    } else snap = snapshotFromFiles(config, base);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    snap = snapshotFromFiles({ ...config, live: undefined }, base);
  }
  const model = buildModel(snap);
  const payload: NetworkPayload = {
    model,
    analysis: analyze(model, snap),
    layout: layoutTopology(model),
    meta: { mode, sample: !!snap.sampleState && mode !== "live", error, configPath: path, refreshedAt: new Date().toISOString() },
  };
  cache = { at: Date.now(), payload };
  return payload;
}

async function liveSnapshot(config: StribogConfig, base: string): Promise<Snapshot> {
  const live = config.live!;
  const password = process.env.STRIBOG_PASSWORD ?? (live.passwordFile ? readFileSync(expand(live.passwordFile, base), "utf8").trim() : "");
  if (!password) throw new Error("No router password: set STRIBOG_PASSWORD or live.passwordFile");
  if (live.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const router = await new RouterOsRest({ url: live.url, user: live.user, password }).snapshot();
  // Exports of other devices (access points) still add detail the router cannot see.
  const files = snapshotFromFiles({ ...config, sources: (config.sources ?? []).filter((s) => s.role !== "router") }, base);
  const overrides = config.overrides ? (JSON.parse(readFileSync(expand(config.overrides, base), "utf8")) as Overrides) : undefined;
  return { collectedAt: new Date().toISOString(), devices: [router, ...files.devices], overrides };
}
