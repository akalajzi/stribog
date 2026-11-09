import { describe, expect, it } from "vitest";
import { compareVersions, updatesOf } from "../src/core/updates.ts";
import { getNetwork } from "../src/server/provider.ts";
import { createSession } from "../src/server/session.ts";

describe("compareVersions", () => {
  it("orders releases by their numbers", () => {
    expect(compareVersions("7.20.4", "7.20.5")).toBeLessThan(0);
    expect(compareVersions("7.21", "7.20.5")).toBeGreaterThan(0);
    expect(compareVersions("7.20", "7.20.0")).toBe(0);
    expect(compareVersions("6.49.18", "7.1")).toBeLessThan(0);
  });
  it("puts pre-releases before their release", () => {
    expect(compareVersions("7.21beta2", "7.21rc1")).toBeLessThan(0);
    expect(compareVersions("7.21rc1", "7.21rc3")).toBeLessThan(0);
    expect(compareVersions("7.21rc3", "7.21")).toBeLessThan(0);
    expect(compareVersions("7.21rc3", "7.20.5")).toBeGreaterThan(0);
  });
});

describe("updatesOf", () => {
  it("says a newer version is out only after a check found one", () => {
    expect(updatesOf({ channel: "stable" }, undefined, "7.20.4")).toEqual({ channel: "stable", installed: "7.20.4", latest: undefined, available: false, status: undefined });
    const u = updatesOf({ channel: "stable", "installed-version": "7.20.4", "latest-version": "7.20.5", status: "New version is available" }, undefined);
    expect(u).toMatchObject({ installed: "7.20.4", latest: "7.20.5", available: true });
    expect(updatesOf({ "installed-version": "7.20.5", "latest-version": "7.20.5" }, undefined)?.available).toBe(false);
  });
  it("notices firmware left behind after an update", () => {
    expect(updatesOf(undefined, { "current-firmware": "7.19.4", "upgrade-firmware": "7.20.4" })?.firmware).toEqual({ current: "7.19.4", upgrade: "7.20.4", behind: true });
    expect(updatesOf(undefined, { "current-firmware": "7.20.4", "upgrade-firmware": "7.20.4" })?.firmware?.behind).toBe(false);
    expect(updatesOf(undefined, undefined)).toBeUndefined();
  });
  it("reads the demo router's versions", async () => {
    const { model } = await getNetwork(createSession("demo"));
    expect(model.updates).toMatchObject({ channel: "stable", installed: "7.20.4", latest: "7.20.5", available: true, firmware: { behind: false } });
  });
});
