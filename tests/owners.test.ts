import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { byOwner } from "../src/core/activity.ts";
import { AsnDb, asnReady, rdap, splitDescription } from "../src/server/owners.ts";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/demo/asn.tsv");

describe("network owners", () => {
  it("splits an AS description into handle and organisation", () => {
    expect(splitDescription("APPLE-ENGINEERING - Apple Inc.")).toEqual({ handle: "APPLE-ENGINEERING", name: "Apple Inc." });
    expect(splitDescription("Example Org")).toEqual({ name: "Example Org" });
    expect(splitDescription("EXAMPLE-NET Example Networks Ltd")).toEqual({ handle: "EXAMPLE-NET", name: "Example Networks Ltd" });
  });

  it("finds the owner of an address by range, and nothing outside the ranges", async () => {
    const db = await AsnDb.load(FIXTURE);
    expect(db.size).toBe(4);
    expect(db.lookup("198.51.100.20")).toEqual({ asn: 64500, name: "Example Streaming Co.", handle: "EXAMPLE-STREAM", country: "ZZ" });
    expect(db.lookup("198.51.100.64")!.asn).toBe(64503);
    expect(db.lookup("192.0.2.255")!.asn).toBe(64501);
    expect(db.lookup("10.0.0.1")).toBeUndefined();
    expect(db.lookup("not an ip")).toBeUndefined();
  });

  it("downloads the database once into the data directory and loads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stribog-asn-"));
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(gzipSync(readFileSync(FIXTURE)), { status: 200 });
    }) as typeof fetch;
    const db = await asnReady(dir, fake);
    expect(calls).toBe(1);
    expect(db?.lookup("203.0.113.88")?.name).toBe("Example Printer Cloud");
    expect(statSync(join(dir, "asn", "ip2asn-v4.tsv.gz")).mode & 0o777).toBe(0o600);
    await asnReady(dir, fake);
    expect(calls).toBe(1);
  });

  it("reads a registry record over RDAP", async () => {
    const fake = (async (url: string) => {
      expect(String(url)).toBe("https://rdap.org/ip/198.51.100.20");
      return new Response(
        JSON.stringify({
          name: "EXAMPLE-NET",
          startAddress: "198.51.100.0",
          endAddress: "198.51.100.255",
          country: "ZZ",
          port43: "whois.example.net",
          entities: [
            { roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "mnt-example"], ["kind", {}, "text", "individual"]]] },
            { roles: ["administrative"], vcardArray: ["vcard", [["fn", {}, "text", "A. Person"], ["kind", {}, "text", "individual"]]] },
            { roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Example Streaming Co."], ["kind", {}, "text", "org"]]], entities: [{ roles: ["abuse"], vcardArray: ["vcard", [["email", {}, "text", "abuse@example.net"]]] }] },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    expect(await rdap("198.51.100.20", fake)).toEqual({
      network: "EXAMPLE-NET",
      range: "198.51.100.0 – 198.51.100.255",
      organisation: "Example Streaming Co.",
      country: "ZZ",
      abuse: "abuse@example.net",
      registry: "whois.example.net",
      link: "https://rdap.org/ip/198.51.100.20",
    });
  });

  it("groups traffic by owner into a top-talkers list with shares, addresses and ports", () => {
    const row = (remote: string, port: number, down: number, owner?: { asn: number; name: string }) => ({ remote, port, protocol: "tcp", scope: (owner ? "internet" : "local") as "internet" | "local", owner, down, up: 0 });
    const top = byOwner([
      row("198.51.100.20", 443, 600, { asn: 64500, name: "Example Streaming Co." }),
      row("198.51.100.21", 443, 200, { asn: 64500, name: "Example Streaming Co." }),
      row("203.0.113.88", 8883, 150, { asn: 64502, name: "Example Printer Cloud" }),
      row("192.168.50.10", 445, 50),
      row("198.51.100.99", 443, 0, { asn: 64510, name: "Example Streaming Co." }),
    ]);
    expect(top.map((t) => [t.name, t.addresses, Math.round(t.share * 100)])).toEqual([
      ["Example Streaming Co.", 3, 80],
      ["Example Printer Cloud", 1, 15],
      ["This network", 1, 5],
    ]);
    expect(top[0]!.ports).toEqual(["443/tcp"]);
  });
});
