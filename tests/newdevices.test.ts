import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markNew, recordSeen, type Seen } from "../src/core/newdevices.ts";
import { getNetwork, notesFor } from "../src/server/provider.ts";
import { createSession } from "../src/server/session.ts";
import { readSeen, writeSeen } from "../src/server/seen.ts";
import type { NetworkModel } from "../src/core/model.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const iso = (t: number) => new Date(t).toISOString();

describe("recordSeen", () => {
  it("takes in every known device at the first record, and online ones after", () => {
    const first = recordSeen(undefined, T0, ["AA"], ["AA", "BB"]);
    expect(first).toEqual({ since: iso(T0), macs: { AA: { first: iso(T0), last: iso(T0) }, BB: { first: iso(T0), last: iso(T0) } } });
    const later = recordSeen(first, T0 + DAY, ["AA", "CC"], ["AA", "BB", "CC", "DD"]);
    expect(later.macs.AA).toEqual({ first: iso(T0), last: iso(T0 + DAY) });
    expect(later.macs.CC).toEqual({ first: iso(T0 + DAY), last: iso(T0 + DAY) });
    // Known to the router but never online since the first record: not seen.
    expect(later.macs.DD).toBeUndefined();
  });
  it("is kept in the data directory", () => {
    const f = join(mkdtempSync(join(tmpdir(), "stribog-seen-")), "seen.json");
    writeSeen(f, T0, ["AA"], ["AA"]);
    writeSeen(f, T0 + 60_000, ["BB"], ["AA", "BB"]);
    expect(Object.keys(readSeen(f)!.macs).sort()).toEqual(["AA", "BB"]);
  });
});

describe("markNew", () => {
  const model = (): NetworkModel =>
    ({
      devices: [
        { id: "a", mac: "AA", zone: "lan", status: "online", facts: [] },
        { id: "b", mac: "BB", zone: "lan", status: "online", facts: [] },
        { id: "c", mac: "CC", zone: "lan", status: "online", reserved: true, facts: [] },
        { id: "d", mac: "DD", zone: "lan", status: "online", facts: [], links: [{ mac: "DD" }, { mac: "EE" }] },
        { id: "ap", mac: "FF", zone: "lan", status: "online", managed: true, facts: [] },
      ],
    }) as unknown as NetworkModel;
  const late = iso(T0 + 10 * DAY);
  const seen: Seen = {
    since: iso(T0),
    macs: { AA: { first: iso(T0 + 3 * DAY), last: late }, BB: { first: late, last: late }, CC: { first: late, last: late }, DD: { first: late, last: late }, EE: { first: iso(T0), last: late }, FF: { first: late, last: late } },
  };

  it("marks devices first seen after the learning week", () => {
    const m = model();
    markNew(m, seen, {});
    const flag = Object.fromEntries(m.devices.map((d) => [d.id, !!d.isNew]));
    // a came in the first week; c has a reservation; d's other connection is old; the AP is the network's own.
    expect(flag).toEqual({ a: false, b: true, c: false, d: false, ap: false });
    expect(m.devices[1]!.firstSeen).toBe(late);
  });
  it("treats any note as knowing the device", () => {
    for (const n of [{ known: true }, { name: "Kid's tablet" }, { labels: ["upstairs"] }]) {
      const m = model();
      markNew(m, seen, { BB: n });
      expect(m.devices[1]!.isNew).toBeUndefined();
    }
    const m = model();
    markNew(m, seen, { BB: { known: false, labels: [], updatedAt: late } });
    expect(m.devices[1]!.isNew).toBe(true);
  });
});

describe("the demo", () => {
  it("has three new devices, and marking one known takes it off", async () => {
    const s = createSession("demo");
    const names = async () => (await getNetwork(s, true)).model.devices.filter((d) => d.isNew).map((d) => d.name).sort();
    expect(await names()).toEqual(["Emma-iPhone", "PS5-living", "guest-laptop"]);
    const notes = notesFor(true);
    notes.updateDevice("00:00:5E:00:53:72", { known: true });
    try {
      expect(await names()).toEqual(["Emma-iPhone", "guest-laptop"]);
    } finally {
      notes.updateDevice("00:00:5E:00:53:72", { known: null });
    }
  });
});
