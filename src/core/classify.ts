// Best-effort device recognition. Every guess is labelled as a guess in the model.

import { isPrivateMac, normMac } from "./net.ts";

export type DeviceKind =
  | "internet"
  | "isp"
  | "router"
  | "switch"
  | "ap"
  | "server"
  | "nas"
  | "desktop"
  | "laptop"
  | "phone"
  | "tablet"
  | "tv"
  | "printer"
  | "printer3d"
  | "console"
  | "camera"
  | "iot"
  | "robot"
  | "unknown";

export const KIND_LABEL: Record<DeviceKind, string> = {
  internet: "Internet",
  isp: "ISP router",
  router: "Router",
  switch: "Switch",
  ap: "Access point",
  server: "Server",
  nas: "NAS",
  desktop: "Desktop",
  laptop: "Laptop",
  phone: "Phone",
  tablet: "Tablet",
  tv: "TV / streamer",
  printer: "Printer",
  printer3d: "3D printer",
  console: "Game console",
  camera: "Camera",
  iot: "Smart device",
  robot: "Robot",
  unknown: "Unknown device",
};

/** Kinds a person can give a device (the rest are Stribog's own: the internet, the ISP box, unknown). */
export const KINDS = (Object.keys(KIND_LABEL) as DeviceKind[]).filter((k) => !["internet", "isp", "unknown"].includes(k));

// Order matters: more specific words first.
const KEYWORDS: [RegExp, DeviceKind][] = [
  [/\b(bambu|p1s|p1p|x1c?|a1 ?mini|prusa|creality|ender|voron|3d ?print)/i, "printer3d"],
  [/\b(printer|brother|epson|canon|hp ?laser|laserjet|officejet|mfc)/i, "printer"],
  [/\b(wap|cap|access ?point|\bap\b|unifi|ubnt|eap\d)/i, "ap"],
  [/\b(nas|synology|diskstation|qnap|truenas|unraid)/i, "nas"],
  [/\b(server|proxmox|esxi|homelab|docker)/i, "server"],
  [/\b(switch|crs\d|css\d)/i, "switch"],
  [/\b(router|xiaomi|miwifi|tp-?link|asus ?rt|nokia|fritz|ont)/i, "router"],
  [/\b(tv|homatics|shield|chromecast|apple ?tv|firetv|fire ?stick|roku|bravia|samsung ?tv|lg ?tv|android ?tv)/i, "tv"],
  [/\b(ipad|tablet|galaxy ?tab)/i, "tablet"],
  [/\b(iphone|android|pixel|galaxy|razr|phone|oneplus|xperia)/i, "phone"],
  [/\b(macbook|mac|laptop|thinkpad|notebook|xps)/i, "laptop"],
  [/\b(desktop|pc|workstation|imac)/i, "desktop"],
  [/\b(playstation|ps5|ps4|xbox|switch ?oled|nintendo|steam ?deck)/i, "console"],
  [/\b(camera|cam\b|doorbell|reolink|hikvision)/i, "camera"],
  [/\b(robot|rover)/i, "robot"],
  [/\b(esp|shelly|tasmota|sonoff|tuya|hue|nest|echo|alexa|homepod|sensor|plug|bulb|vacuum|roborock)/i, "iot"],
];

export function kindFromText(...texts: (string | undefined)[]): DeviceKind | undefined {
  const t = texts.filter(Boolean).join(" ");
  if (!t) return undefined;
  for (const [re, kind] of KEYWORDS) if (re.test(t)) return kind;
  return undefined;
}

// A deliberately small OUI table of vendors common in homes. Unknown is fine; the UI says so.
const OUI: Record<string, [string, DeviceKind?]> = {
  "00:11:32": ["Synology", "nas"],
  "90:09:D0": ["Synology", "nas"],
  "24:5E:BE": ["QNAP", "nas"],
  "B8:27:EB": ["Raspberry Pi", "server"],
  "DC:A6:32": ["Raspberry Pi", "server"],
  "E4:5F:01": ["Raspberry Pi", "server"],
  "2C:CF:67": ["Raspberry Pi", "server"],
  "D8:3A:DD": ["Raspberry Pi", "server"],
  "38:32:7A": ["MikroTik"],
  "48:8F:5A": ["MikroTik"],
  "64:D1:54": ["MikroTik"],
  "74:4D:28": ["MikroTik"],
  "B8:69:F4": ["MikroTik"],
  "CC:2D:E0": ["MikroTik"],
  "DC:2C:6E": ["MikroTik"],
  "E4:8D:8C": ["MikroTik"],
  "2C:C8:1B": ["MikroTik"],
  "08:55:31": ["MikroTik"],
  "18:FD:74": ["MikroTik"],
  "78:9A:18": ["MikroTik"],
  "C4:AD:34": ["MikroTik"],
  "F4:1E:57": ["MikroTik"],
  "24:0A:C4": ["Espressif", "iot"],
  "30:AE:A4": ["Espressif", "iot"],
  "3C:61:05": ["Espressif", "iot"],
  "7C:9E:BD": ["Espressif", "iot"],
  "A4:CF:12": ["Espressif", "iot"],
  "84:F3:EB": ["Espressif", "iot"],
  "EC:FA:BC": ["Espressif", "iot"],
  "00:17:88": ["Philips Hue", "iot"],
  "B0:BE:76": ["TP-Link"],
  "50:C7:BF": ["TP-Link"],
  "F0:9F:C2": ["Ubiquiti", "ap"],
  "74:83:C2": ["Ubiquiti", "ap"],
  "00:1B:A9": ["Brother", "printer"],
  "00:80:77": ["Brother", "printer"],
  "3C:2A:F4": ["Brother", "printer"],
};

export function vendorOf(mac: string | undefined): { vendor?: string; kind?: DeviceKind; private: boolean } {
  const m = normMac(mac);
  if (isPrivateMac(m)) return { private: true };
  const hit = OUI[m.slice(0, 8)];
  return { vendor: hit?.[0], kind: hit?.[1], private: false };
}

/** Devices that are 2.4 GHz-only by design, so being on 2.4 GHz is expected rather than a problem. */
export function likelyOnly24(kind: DeviceKind, ...texts: (string | undefined)[]): boolean {
  const t = texts.filter(Boolean).join(" ");
  if (/\b(bambu|p1s|p1p|a1 ?mini|shelly|sonoff|tuya|esp)/i.test(t)) return true;
  return kind === "iot" || kind === "printer3d";
}

/** Turn a long DHCP comment into a short display name. */
export function shortName(comment: string): string {
  let s = comment.split(/\s+[-–—|]\s+|\s+via\s+|\s*\(/i)[0]!.trim();
  if (s.length > 22) s = s.split(/\s+/).slice(0, 3).join(" ");
  return s;
}
