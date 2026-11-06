// The review only diagnoses; a request for advice hands an agent the finding with its context.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { adviceRequest, menuText } from "../src/core/advice.ts";
import { analyze } from "../src/core/analyze.ts";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { buildModel } from "../src/core/model.ts";

const DEMO = resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json");
const { config, base } = readConfig(DEMO);
const snap = snapshotFromFiles(config, base);
const model = buildModel(snap);
const a = analyze(model, snap);

describe("the review", () => {
  it("gives no fixes, and notes which configuration each check read", () => {
    for (const f of a.findings) expect(f).not.toHaveProperty("fix");
    expect(a.findings.find((f) => f.id === "svc-unrestricted")?.reads).toContain("router /ip/service");
    // Access points' configuration is noted per access point.
    expect(a.findings.find((f) => f.id === "cap-versions-differ")?.reads?.some((r) => /^ap\d /.test(r))).toBe(true);
  });
});

describe("a request for advice", () => {
  const f = a.findings.find((x) => x.id === "svc-unrestricted")!;
  const text = adviceRequest({ finding: f, model, snap, notes: snap.notes });

  it("carries the finding, the network, the configuration read and what to answer", () => {
    expect(text).toMatch(/^# Advice wanted: /);
    expect(text).toContain(`Check: \`svc-unrestricted\``);
    expect(text).toContain("## Configuration it is about");
    expect(text).toContain("/ip service\n");
    expect(text).toContain("RouterOS 7.20.4");
    expect(text).toContain("Safe Mode");
    expect(text).toContain("never a broad `find`");
  });

  it("falls back to the usual menus for checks that read only the model", () => {
    const w = a.findings.find((x) => x.category === "wifi" && !x.reads && x.severity !== "pass")!;
    expect(adviceRequest({ finding: w, model, snap })).toContain("/interface wifi");
  });

  it("hides secrets and says when a menu is empty", () => {
    expect(menuText("/interface/wifi/security", [{ name: "home", passphrase: "hunter22", "authentication-types": "wpa2-psk,wpa3-psk" }])).toBe(
      "/interface wifi security\nadd name=home passphrase=<hidden> authentication-types=wpa2-psk,wpa3-psk",
    );
    expect(menuText("/system/scheduler", [])).toContain("nothing configured");
  });
});

describe("accepting a finding", () => {
  const f = a.findings.find((x) => x.severity === "warning" || x.severity === "suggestion")!;
  const withNotes = (accepted: Record<string, { title: string; reason?: string; at: string }>) => {
    const s = { ...snap, notes: { ...snap.notes, accepted } };
    return analyze(buildModel(s), s);
  };

  it("stops counting it while it says the same", () => {
    const b = withNotes({ [f.id]: { title: f.title, reason: "nobody uses it", at: "2026-11-06T12:00:00Z" } });
    const g = b.findings.find((x) => x.id === f.id)!;
    expect(g.accepted).toEqual({ reason: "nobody uses it", at: "2026-11-06T12:00:00Z" });
    expect(b.accepted).toBe(1);
    expect(b.counts[f.severity]).toBe(a.counts[f.severity] - 1);
    expect(b.findings.filter((x) => x.accepted)).toHaveLength(1);
  });

  it("counts it again once it has changed", () => {
    const b = withNotes({ [f.id]: { title: "something it used to say", at: "2026-11-06T12:00:00Z" } });
    const g = b.findings.find((x) => x.id === f.id)!;
    expect(g.accepted).toBeUndefined();
    expect(g.changedSinceAccepted?.title).toBe("something it used to say");
    expect(b.counts).toEqual(a.counts);
  });
});
