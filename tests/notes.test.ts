import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotesError, NotesStore } from "../src/server/notes.ts";
import { TokenStore } from "../src/server/tokens.ts";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "stribog-notes-"));
  return { dir, store: new NotesStore(join(dir, "notes.json"), join(dir, "audit.jsonl")) };
};
const MAC = "00:00:5E:00:53:10";

describe("NotesStore", () => {
  it("merges device notes by MAC, in any case or separator, and stamps the change", () => {
    const { store } = fresh();
    store.updateDevice("00-00-5e-00-53-10", { name: " Family NAS ", labels: ["Hall", "Hall", "storage"] });
    const d = store.updateDevice(MAC, { description: "Shared storage.", services: [{ name: "DNS", port: 53, protocol: "UDP" }] });
    expect(d).toMatchObject({ name: "Family NAS", labels: ["Hall", "storage"], description: "Shared storage.", services: [{ name: "DNS", port: 53, protocol: "udp" }] });
    expect(Date.parse(d.updatedAt!)).toBeGreaterThan(0);
    expect(Object.keys(store.get().devices!)).toEqual([MAC]);
  });

  it("clears a field with null, replaces with PUT semantics, and drops an emptied entry", () => {
    const { store } = fresh();
    store.updateDevice(MAC, { name: "NAS", notes: "x", labels: ["a"] });
    expect(store.updateDevice(MAC, { notes: null })).not.toHaveProperty("notes");
    expect(store.updateDevice(MAC, { kind: "nas" }, true)).toEqual({ kind: "nas", updatedAt: expect.any(String) });
    store.updateDevice(MAC, { kind: null });
    expect(store.get().devices).toEqual({});
  });

  it("accepts every kind a person can choose, robots included", () => {
    const { store } = fresh();
    expect(store.updateDevice(MAC, { kind: "robot" })).toMatchObject({ kind: "robot" });
  });

  it("refuses unknown fields, bad kinds, ports and URLs with a plain reason", () => {
    const { store } = fresh();
    expect(() => store.updateDevice(MAC, { room: "Hall" })).toThrow(/Unknown field “room”/);
    expect(() => store.updateDevice(MAC, { kind: "toaster" })).toThrow(/kind must be one of/);
    expect(() => store.updateDevice(MAC, { services: [{ name: "x", port: 70000 }] })).toThrow(/port/);
    expect(() => store.updateDevice(MAC, { services: [{ name: "x", url: "javascript:alert(1)" }] })).toThrow(/http/);
    expect(() => store.updateDevice("not-a-mac", { name: "x" })).toThrow(NotesError);
    expect(store.get()).toEqual({});
  });

  it("keeps an append-only change log with before and after", () => {
    const { dir, store } = fresh();
    store.updateDevice(MAC, { name: "NAS" });
    store.updateDevice(MAC, { name: "Family NAS" });
    store.updateNetwork({ site: "Maple Street", upstream: { isp: "Example Fibre" } });
    store.deleteDevice(MAC);
    const log = store.audit();
    expect(log.map((e) => e.target)).toEqual([`device:${MAC}`, "network", `device:${MAC}`, `device:${MAC}`]);
    expect(log[0]).toMatchObject({ after: null, before: { name: "Family NAS" } });
    expect(log[2]).toMatchObject({ before: { name: "NAS" }, after: { name: "Family NAS" } });
    expect(log[3]).toMatchObject({ before: null, after: { name: "NAS" } });
    expect(statSync(join(dir, "notes.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "audit.jsonl")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, "notes.json"), "utf8"))).toMatchObject({ site: "Maple Street", upstream: { isp: "Example Fibre" } });
  });

  it("keeps the demo's edits in memory and leaves its file alone", () => {
    const { dir } = fresh();
    const demo = new NotesStore(join(dir, "missing.json"), undefined, false);
    demo.updateDevice(MAC, { name: "Tried it" });
    expect(demo.device(MAC)?.name).toBe("Tried it");
    expect(() => statSync(join(dir, "missing.json"))).toThrow();
  });
});

describe("TokenStore", () => {
  it("shows a token once, stores only its hash, and can revoke it", () => {
    const dir = mkdtempSync(join(tmpdir(), "stribog-tokens-"));
    const tokens = new TokenStore(join(dir, "tokens.json"));
    const { token, info } = tokens.create("  Claude  ");
    expect(token).toMatch(/^stb_[\w-]{40,}$/);
    expect(info.name).toBe("Claude");
    expect(readFileSync(join(dir, "tokens.json"), "utf8")).not.toContain(token);
    expect(tokens.verify(token)).toMatchObject({ id: info.id, name: "Claude" });
    expect(tokens.list()[0]!.lastUsedAt).toBeDefined();
    expect(tokens.verify(token.slice(0, -1) + "x")).toBeUndefined();
    expect(tokens.revoke(info.id)).toBe(true);
    expect(tokens.verify(token)).toBeUndefined();
  });
});
