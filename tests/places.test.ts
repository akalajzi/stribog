import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { networkByPlace } from "../src/core/activity.ts";
import { readConfig, snapshotFromFiles } from "../src/core/load.ts";
import { buildModel } from "../src/core/model.ts";
import { MAP_H, MAP_W, project } from "../src/core/projection.ts";
import { COUNTRIES, LAND, ZONES } from "../src/core/world.ts";
import { CountryDb, countryReady, countryUrl } from "../src/server/places.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/demo/countries.csv");

describe("countries of addresses", () => {
  it("finds an address's country by range, and nothing outside the ranges", async () => {
    const db = await CountryDb.load(FIXTURE);
    expect(db.lookup("198.51.100.20")).toBe("NL");
    expect(db.lookup("198.51.100.64")).toBe("IE");
    expect(db.lookup("203.0.113.255")).toBe("US");
    expect(db.lookup("10.0.0.1")).toBeUndefined();
    expect(db.lookup("2001:db8::1")).toBeUndefined();
  });

  it("joins neighbouring ranges in one country and skips IPv6 and unknown rows", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "stribog-geo-")), "c.csv");
    writeFileSync(path, ["192.0.2.0,192.0.2.127,DE", "192.0.2.128,192.0.2.255,DE", "198.51.100.0,198.51.100.255,ZZ", "2001:db8::,2001:db8::ffff,FR", "203.0.113.0,203.0.113.255,FR"].join("\n"));
    const db = await CountryDb.load(path);
    expect(db.size).toBe(2);
    expect(db.lookup("192.0.2.200")).toBe("DE");
    expect(db.lookup("198.51.100.1")).toBeUndefined();
  });

  it("downloads this month's file, or last month's when it is not out yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stribog-geo-"));
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(String(url));
      return asked.length === 1 ? new Response("", { status: 404 }) : new Response(gzipSync(readFileSync(FIXTURE)), { status: 200 });
    }) as typeof fetch;
    const db = await countryReady(dir, fake);
    expect(db?.lookup("192.0.2.80")).toBe("DE");
    const now = new Date();
    expect(asked).toEqual([countryUrl(now), countryUrl(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))]);
    expect(asked[0]).toMatch(/^https:\/\/download\.db-ip\.com\/free\/dbip-country-lite-\d{4}-\d{2}\.csv\.gz$/);
    expect(statSync(join(dir, "geo", "dbip-country-lite.csv.gz")).mode & 0o777).toBe(0o600);
  });
});

describe("the world map", () => {
  it("projects the world onto a flat map, 180°W 84°N at the top left and 180°E 58°S at the bottom right", () => {
    const [x0, y0] = project(-180, 84);
    expect(x0).toBeCloseTo(0);
    expect(y0).toBeCloseTo(0);
    const [x1, y1] = project(180, -58);
    expect(x1).toBeCloseTo(MAP_W);
    expect(y1).toBeCloseTo(MAP_H);
    expect(project(0, 0)[0]).toBeCloseTo(MAP_W / 2);
    // Mercator: a degree of latitude is longer further north, the same width everywhere.
    expect(project(0, 50)[1] - project(0, 60)[1]).toBeGreaterThan(project(0, 0)[1] - project(0, 10)[1]);
    expect(project(10, 60)[0] - project(0, 60)[0]).toBeCloseTo(project(10, 0)[0] - project(0, 0)[0]);
  });

  it("has a point for countries and time zones, old names included", () => {
    expect(LAND.startsWith("M")).toBe(true);
    for (const cc of ["US", "DE", "SG", "HK", "LU", "JP", "BR"]) expect(COUNTRIES[cc]).toBeDefined();
    expect(ZONES["Europe/London"]?.[2]).toBe("GB");
    expect(ZONES["Europe/Kiev"]).toEqual(ZONES["Europe/Kyiv"]);
  });
});

describe("the whole network by country, now", () => {
  it("adds up traffic per country, with who runs the other ends and who in the home talks to them", async () => {
    const { config, base } = readConfig(resolve(import.meta.dirname, "../fixtures/demo/stribog.config.json"));
    const snap = snapshotFromFiles(config, base);
    const m = buildModel(snap);
    const conns = snap.devices[0]!.state!["/ip/firewall/connection"]!;
    const db = await CountryDb.load(FIXTURE);
    const owner = (ip: string) => (ip.startsWith("198.51.100.") ? { asn: 64500, name: "Example Streaming Co." } : undefined);
    const rows = networkByPlace(conns, 60, m, (ip) => db.lookup(ip), owner);
    const nl = rows.find((r) => r.country === "NL")!;
    expect(rows[0]).toBe(nl);
    expect(nl.owners.map((o) => o.name)).toEqual(["Example Streaming Co."]);
    expect(Math.abs(nl.owners[0]!.bps - (nl.downBps + nl.upBps))).toBeLessThanOrEqual(1);
    expect(nl.devices.map((d) => d.name)).toContain("Alex MacBook");
    expect(rows.find((r) => r.country === "DE")?.owners[0]?.name).toBe("Unknown network");
    expect(rows.every((r) => r.downBps + r.upBps > 0)).toBe(true);
  });
});
