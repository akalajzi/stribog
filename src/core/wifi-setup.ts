// Changing a Wi-Fi network: its name, password and security. Finds where each is set on the
// router (a configuration, a security profile it uses, or the radio's own settings) and turns the
// change into item changes for the timed-undo flow. The password never leaves this module as text
// anything shows: plans carry it only in the changes sent to the router.

import { securityOf, type WifiSecurity } from "./change.ts";
import { list, type RosRecord } from "./ros.ts";
import { changeLines, type ItemChange } from "./undo.ts";

export const CONF = "/interface/wifi/configuration";
export const SEC = "/interface/wifi/security";
export const IFACE = "/interface/wifi";
export const WIFI_TABLES = [CONF, SEC, IFACE];

/** How long a person has to come back and keep a Wi-Fi change. */
export const WIFI_UNDO_SECONDS = 150;

export type Security = Exclude<WifiSecurity, "other">;
export const AUTH: Record<Security, string> = { wpa2: "wpa2-psk", "wpa2-wpa3": "wpa2-psk,wpa3-psk", wpa3: "wpa3-psk" };
export const SECURITY_NAME: Record<Security, string> = { wpa2: "WPA2", "wpa2-wpa3": "WPA2 + WPA3", wpa3: "WPA3 only" };

export interface WifiEdit {
  /** The network as it is called now. */
  ssid: string;
  name?: string;
  password?: string;
  security?: Security;
}

export interface WifiPlan {
  ssid: string;
  /** In plain words: "Rename “Maple” to “Maple Home”". */
  summary: string[];
  changes: ItemChange[];
  /** The changes as terminal commands, password masked. */
  lines: string[];
  notes: string[];
  undoSeconds: number;
}

export class WifiRefused extends Error {}

const dyn = (r: RosRecord) => r.dynamic === "true";
const q = (s: string) => `“${s}”`;

/** What a network's settings are made of, from the router's tables. */
export function wifiParts(tables: Record<string, RosRecord[] | undefined>, ssid: string) {
  const confs = (tables[CONF] ?? []).filter((c) => !dyn(c) && c.ssid === ssid && c.name && c[".id"]);
  const ifaces = (tables[IFACE] ?? []).filter((w) => !dyn(w) && w["configuration.ssid"] === ssid && w.name && w[".id"]);
  const secs = tables[SEC] ?? [];
  const profileOf = (r: RosRecord) => secs.find((s) => s.name === r.security && s[".id"]);
  const profiles = [...new Map([...confs, ...ifaces].map(profileOf).filter((p): p is RosRecord => !!p).map((p) => [p[".id"], p])).values()];
  const inlineConfs = confs.filter((c) => !profileOf(c));
  const inlineIfaces = ifaces.filter((w) => !profileOf(w));
  // Other networks that use the same security profiles: their password changes too.
  const shared = [...new Set((tables[CONF] ?? []).filter((c) => c.ssid !== ssid && profiles.some((p) => p.name === c.security)).map((c) => c.ssid ?? c.name ?? "?"))];
  const auth = list(profiles[0]?.["authentication-types"] ?? inlineConfs[0]?.["security.authentication-types"] ?? inlineIfaces[0]?.["security.authentication-types"]);
  return { confs, ifaces, profiles, inlineConfs, inlineIfaces, shared, security: securityOf(auth) };
}

/** A WPA passphrase: 8 to 63 printable ASCII characters. */
export function passwordProblem(p: string): string | undefined {
  if (p.length < 8) return "A Wi-Fi password needs at least 8 characters.";
  if (p.length > 63) return "A Wi-Fi password can have at most 63 characters.";
  if (!/^[\x20-\x7e]+$/.test(p)) return "Use letters, digits, spaces and the usual symbols only: some devices cannot type anything else.";
  return undefined;
}

export function nameProblem(n: string): string | undefined {
  if (!n.trim()) return "The network needs a name.";
  if (new TextEncoder().encode(n).length > 32) return "A Wi-Fi name can be at most 32 bytes long.";
  if (n !== n.trim()) return "Leave out spaces at the start and end: devices show them, people do not see them.";
  return undefined;
}

export function planWifiEdit(tables: Record<string, RosRecord[] | undefined>, edit: WifiEdit, otherNames: string[] = []): WifiPlan {
  const p = wifiParts(tables, edit.ssid);
  if (!p.confs.length && !p.ifaces.length) throw new WifiRefused(`Stribog cannot find where ${q(edit.ssid)} is set on the router. It may be set on an access point itself, which Stribog does not change.`);
  const changes: ItemChange[] = [];
  const summary: string[] = [];
  const notes: string[] = [];
  const name = edit.name?.trim();
  const rename = name !== undefined && name !== edit.ssid;
  const security = edit.security && edit.security !== p.security ? edit.security : undefined;
  const password = edit.password || undefined;

  if (rename) {
    const bad = nameProblem(edit.name!);
    if (bad) throw new WifiRefused(bad);
    if (otherNames.includes(name)) throw new WifiRefused(`There is already a network called ${q(name)}.`);
  }
  if (password) {
    const bad = passwordProblem(password);
    if (bad) throw new WifiRefused(bad);
  }
  if ((security || password) && p.inlineIfaces.length) throw new WifiRefused(`The security of ${q(edit.ssid)} is set on the radio itself (${p.inlineIfaces.map((w) => w.name).join(", ")}). Stribog only changes security profiles and configurations; change it in WinBox or WebFig.`);
  if ((security || password) && p.security === "other" && !security) throw new WifiRefused(`${q(edit.ssid)} uses a kind of security Stribog does not change (not WPA2 or WPA3 with a password).`);

  // One change per item, with everything that item needs.
  const add = (path: string, r: RosRecord, what: string, set: Record<string, string>, secret?: string[]) => {
    const has = changes.find((c) => c.path === path && c.id === r[".id"]);
    if (has) {
      Object.assign(has.set, set);
      if (secret) has.secret = [...(has.secret ?? []), ...secret];
    } else changes.push({ path, id: r[".id"]!, name: r.name!, what, set: { ...set }, ...(secret ? { secret } : {}) });
  };
  if (rename) {
    for (const c of p.confs) add(CONF, c, `configuration ${q(c.name!)}`, { ssid: name });
    for (const w of p.ifaces) add(IFACE, w, `radio ${q(w.name!)}`, { "configuration.ssid": name });
    summary.push(`Rename ${q(edit.ssid)} to ${q(name)}.`);
  }
  if (security || password) {
    const set = (prefix: string) => ({ ...(security ? { [`${prefix}authentication-types`]: AUTH[security] } : {}), ...(password ? { [`${prefix}passphrase`]: password } : {}) });
    const secret = (prefix: string) => (password ? [`${prefix}passphrase`] : undefined);
    for (const s of p.profiles) add(SEC, s, `security profile ${q(s.name!)}`, set(""), secret(""));
    for (const c of p.inlineConfs) add(CONF, c, `configuration ${q(c.name!)}`, set("security."), secret("security."));
    if (security) summary.push(`Security: ${SECURITY_NAME[security]} instead of ${p.security === "other" ? "what it has now" : SECURITY_NAME[p.security]}.`);
    if (password) summary.push("A new password.");
    if (p.shared.length) notes.push(`The security profile is shared with ${p.shared.map(q).join(" and ")}: ${p.shared.length === 1 ? "that network gets" : "those get"} the new ${[security && "security", password && "password"].filter(Boolean).join(" and ")} too.`);
  }
  if (!changes.length) throw new WifiRefused("Nothing to change: that is how it is set already.");

  if (security === "wpa3") notes.push("WPA3 only: devices older than about 2019 (and many smart-home gadgets) cannot join. WPA2 + WPA3 lets them in while newer devices use WPA3.");
  if (rename || password) notes.push(`Every device on ${q(edit.ssid)} drops off. ${rename ? `They find it again as ${q(name)}` : "They join again"}${password ? " with the new password" : ""}${rename ? "; devices that remember the old name do not join on their own" : ""}.`);
  else notes.push(`Devices on ${q(edit.ssid)} reconnect, which takes a few seconds.`);
  notes.push(`If you are on this Wi-Fi, you drop off too. Join again and press Keep within ${Math.round(WIFI_UNDO_SECONDS / 30) / 2} minutes; otherwise the router puts the old settings back by itself.`);
  if (p.confs.length && (tables[IFACE] ?? []).some((w) => dyn(w) || p.confs.some((c) => c.name === w.configuration))) notes.push("Access points that get their Wi-Fi from this router (CAPsMAN) take the change from it.");

  return { ssid: edit.ssid, summary, changes, lines: changeLines(changes), notes, undoSeconds: WIFI_UNDO_SECONDS };
}
