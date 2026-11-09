// Is there a newer RouterOS for the router, and is its firmware (RouterBOOT) behind? RouterOS
// knows the newest version only after it has checked with MikroTik's server
// (`/system/package/update/check-for-updates`), which Stribog asks it to do once a day.

import type { RosRecord } from "./ros.ts";

export interface Updates {
  channel: string;
  installed?: string;
  /** The newest version on the channel, as of the router's last check. */
  latest?: string;
  /** `latest` is newer than `installed`. */
  available: boolean;
  /** The router's own words about the last check ("System is already up to date", an error). */
  status?: string;
  /** RouterBOOT: the firmware in use, and the one the installed RouterOS brings. */
  firmware?: { current: string; upgrade: string; behind: boolean };
}

/**
 * RouterOS versions ("7.20.4", "7.21rc2", "7.21beta1") compared: negative when a is older.
 * A pre-release comes before its release: 7.21beta1 < 7.21rc1 < 7.21.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+(?:\.\d+)*)(?:(alpha|beta|rc)(\d+))?/.exec(v.trim());
    if (!m) return undefined;
    const pre = m[2] ? { alpha: 0, beta: 1, rc: 2 }[m[2] as "alpha" | "beta" | "rc"] : 3;
    return { nums: m[1]!.split(".").map(Number), pre, preN: Number(m[3] ?? 0) };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  return x.pre - y.pre || x.preN - y.preN;
}

/**
 * From `/system/package/update` (configuration has only the channel; a live read adds the
 * versions and status) and `/system/routerboard`. Undefined when neither says anything.
 */
export function updatesOf(pkg: RosRecord | undefined, rb: RosRecord | undefined, running?: string): Updates | undefined {
  const installed = pkg?.["installed-version"] || running;
  const latest = pkg?.["latest-version"] || undefined;
  const current = rb?.["current-firmware"];
  const upgrade = rb?.["upgrade-firmware"];
  if (!pkg && !current) return undefined;
  return {
    channel: pkg?.channel ?? "stable",
    installed,
    latest,
    available: !!(installed && latest && compareVersions(latest, installed) > 0),
    status: pkg?.status || undefined,
    ...(current && upgrade ? { firmware: { current, upgrade, behind: compareVersions(current, upgrade) < 0 } } : {}),
  };
}

/** Where the release notes are. */
export const CHANGELOG_URL = "https://mikrotik.com/download/changelogs";
