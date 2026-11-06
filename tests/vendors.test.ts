// Makers of network interfaces from the IEEE registry of MAC prefixes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kindFromVendor, shortVendor, vendorOf } from "../src/core/classify.ts";
import { buildModel } from "../src/core/model.ts";
import { parseExport } from "../src/core/ros.ts";
import { OUI_URLS, parseOuiCsv, vendorReady } from "../src/server/vendors.ts";

const CSV = `Registry,Assignment,Organization Name,Organization Address
MA-L,0A0B0C,"Example Widgets Co., Ltd.","1 Road, Town CN 100000 "
MA-L,0A0B0D,Private,
MA-L,0A0B0E,IEEE Registration Authority,445 Hoes Lane Piscataway NJ US 08554
MA-M,0A0B0E1,Tuya Smart Inc.,"FLAT 806, Hong Kong CN 999077 "
MA-S,0A0B0E123,"Quote ""Q"" Labs GmbH",Somewhere DE
`;

describe("the IEEE registry", () => {
  it("reads the CSV, skipping private and IEEE-held blocks", () => {
    expect(parseOuiCsv(CSV)).toEqual([
      ["0A0B0C", "Example Widgets Co., Ltd."],
      ["0A0B0E1", "Tuya Smart Inc."],
      ["0A0B0E123", 'Quote "Q" Labs GmbH'],
    ]);
  });

  it("downloads all three registries weekly and finds the longest matching prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stribog-oui-"));
    const filler = Array.from({ length: 1200 }, (_, i) => `MA-L,${(0x100000 + i).toString(16).toUpperCase()},Maker ${i},Somewhere`).join("\n");
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      return new Response(url === OUI_URLS[0] ? `${CSV}${filler}\n` : "Registry,Assignment,Organization Name,Organization Address\n");
    }) as unknown as typeof fetch;
    const db = (await vendorReady(dir, fake))!;
    expect(seen).toEqual(OUI_URLS);
    expect(db.lookup("0a-0b-0c-11-22-33")).toBe("Example Widgets Co., Ltd.");
    expect(db.lookup("0A:0B:0E:12:34:56")).toBe('Quote "Q" Labs GmbH');
    expect(db.lookup("0A:0B:0E:19:99:99")).toBe("Tuya Smart Inc.");
    expect(db.lookup("0A:0B:0E:FF:00:00")).toBeUndefined();
  });
});

describe("makers in the model", () => {
  it("shortens organisation names and knows makers of one kind of device", () => {
    expect(shortVendor("Tuya Smart Inc.")).toBe("Tuya Smart");
    expect(shortVendor("Example Widgets Co., Ltd.")).toBe("Example Widgets");
    expect(shortVendor("Hon Hai Precision Ind. Co.,Ltd.")).toBe("Hon Hai Precision Ind");
    expect(kindFromVendor("Tuya Smart Inc.")).toBe("iot");
    expect(kindFromVendor("Xiaomi Communications Co Ltd")).toBeUndefined();
  });

  it("never looks up private addresses, and prefers the short built-in names", () => {
    const registry = () => "Should Not Be Used Inc.";
    expect(vendorOf("02:00:5E:10:00:01", registry)).toEqual({ private: true });
    expect(vendorOf("00:11:32:00:00:01", registry)).toMatchObject({ vendor: "Synology", kind: "nas" });
  });

  it("names an unknown device after its registered maker, and says what that means", () => {
    const rsc = `/interface bridge\nadd name=lan\n/ip address\nadd address=10.0.0.1/24 interface=lan\n`;
    const state = {
      "/ip/dhcp-server/lease": [{ address: "10.0.0.26", "mac-address": "00:00:5E:00:53:68", status: "bound", "host-name": "wlan0" }],
    };
    const m = buildModel({ collectedAt: "x", devices: [{ role: "router", config: parseExport(rsc), state, sources: [] }] }, { vendors: (mac) => (mac === "00:00:5E:00:53:68" ? "Tuya Smart Inc." : undefined) });
    const d = m.devices.find((x) => x.mac === "00:00:5E:00:53:68")!;
    expect(d).toMatchObject({ vendor: "Tuya Smart", kind: "iot", kindCertainty: "inferred" });
    expect(d.facts).toContain("Its network chip is registered to Tuya Smart Inc. (IEEE registry): often the maker of a module inside the device, not of the device itself");
  });
});
