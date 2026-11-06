// Small, dependency-free network helpers.

export const normMac = (mac: string | undefined) => (mac ?? "").trim().toUpperCase().replace(/-/g, ":");

/** Locally administered MACs are what phones and laptops use for "private Wi-Fi address". */
export function isPrivateMac(mac: string | undefined): boolean {
  const m = normMac(mac);
  if (!/^[0-9A-F]{2}:/.test(m)) return false;
  return (parseInt(m.slice(0, 2), 16) & 0x02) !== 0;
}

export function ipToInt(ip: string): number | undefined {
  const m = ip.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

export const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

export function parseCidr(cidr: string): { ip: string; prefix: number; network: number; size: number } | undefined {
  const [ip, p] = cidr.split("/");
  const n = ipToInt(ip ?? "");
  const prefix = p === undefined ? 32 : Number(p);
  if (n === undefined || !(prefix >= 0 && prefix <= 32)) return undefined;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { ip: ip!, prefix, network: (n & mask) >>> 0, size: 2 ** (32 - prefix) };
}

export function inCidr(ip: string, cidr: string): boolean {
  const c = parseCidr(cidr);
  const n = ipToInt(ip);
  if (!c || n === undefined) return false;
  return n >= c.network && n < c.network + c.size;
}

export function cidrString(cidr: string): string {
  const c = parseCidr(cidr);
  return c ? `${intToIp(c.network)}/${c.prefix}` : cidr;
}

const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const CGNAT = "100.64.0.0/10";

export const isPrivateIp = (ip: string) => PRIVATE.some((c) => inCidr(ip, c));
export const isCgnatIp = (ip: string) => inCidr(ip, CGNAT);

/** Count addresses in RouterOS pool ranges: "10.0.0.10-10.0.0.99,10.0.0.120". */
export function poolSize(ranges: string[]): number {
  let total = 0;
  for (const r of ranges) {
    if (r.includes("/")) {
      total += parseCidr(r)?.size ?? 0;
      continue;
    }
    const [a, b] = r.split("-");
    const x = ipToInt(a ?? "");
    const y = b ? ipToInt(b) : x;
    if (x !== undefined && y !== undefined && y >= x) total += y - x + 1;
  }
  return total;
}

export function inPool(ip: string, ranges: string[]): boolean {
  const n = ipToInt(ip);
  if (n === undefined) return false;
  return ranges.some((r) => {
    if (r.includes("/")) return inCidr(ip, r);
    const [a, b] = r.split("-");
    const x = ipToInt(a ?? "");
    const y = b ? ipToInt(b) : x;
    return x !== undefined && y !== undefined && n >= x && n <= y;
  });
}

// ---------------------------------------------------------------------------
// Wi-Fi channels

export type Band = "2.4" | "5" | "6";

export function bandOf(freq: number): Band {
  if (freq < 3000) return "2.4";
  if (freq < 5925) return "5";
  return "6";
}

export function channelOf(freq: number): number {
  if (freq === 2484) return 14;
  if (freq < 3000) return Math.round((freq - 2407) / 5);
  if (freq < 5925) return Math.round((freq - 5000) / 5);
  return Math.round((freq - 5950) / 5);
}

export const freqOfChannel = (band: Band, ch: number) =>
  band === "2.4" ? (ch === 14 ? 2484 : 2407 + ch * 5) : band === "5" ? 5000 + ch * 5 : 5950 + ch * 5;

/** 5 GHz channels that require radar detection (DFS) in the EU. */
export const isDfs = (ch: number) => ch >= 52 && ch <= 144;

/** RouterOS band names: "2ghz-ax", "5ghz-n/ac" ... */
export function bandFromRos(v: string | undefined): Band | undefined {
  if (!v) return undefined;
  if (v.startsWith("2ghz")) return "2.4";
  if (v.startsWith("5ghz")) return "5";
  if (v.startsWith("6ghz")) return "6";
  return undefined;
}

/**
 * Parse RouterOS channel status like "5220/ax/eeCe/I" or "2462/ax".
 * The extension-channel letters encode the width: none/"C" = 20, "Ce" = 40, "eeCe" = 80, 8 letters = 160.
 */
export function parseChannelStatus(v: string | undefined): { freq: number; channel: number; band: Band; width: number; dfs: boolean } | undefined {
  if (!v) return undefined;
  const [f, , ext] = v.split("/");
  const freq = Number(f);
  if (!freq) return undefined;
  const letters = (ext ?? "").replace(/[^ceCE]/g, "").length;
  const width = letters >= 8 ? 160 : letters >= 4 ? 80 : letters >= 2 ? 40 : 20;
  const band = bandOf(freq);
  const channel = channelOf(freq);
  return { freq, channel, band, width, dfs: band === "5" && isDfs(channel) };
}

/** 20 MHz channels covered by a transmission of `width` MHz whose primary is `primary`. */
export function coveredChannels(band: Band, primary: number, width: number): number[] {
  if (band === "2.4") {
    // A 20 MHz 2.4 GHz signal spills about two channels to each side.
    const span = width >= 40 ? 6 : 2;
    const out: number[] = [];
    for (let c = primary - span; c <= primary + span; c++) if (c >= 1 && c <= 13) out.push(c);
    return out;
  }
  const blocks = width / 20;
  if (blocks <= 1) return [primary];
  // 5/6 GHz bonding uses fixed, aligned blocks.
  const base = band === "5" ? (primary >= 149 ? 149 : 36) : 1;
  const idx = Math.floor((primary - base) / 4 / blocks) * blocks;
  return Array.from({ length: blocks }, (_, i) => base + (idx + i) * 4);
}

export const parseSignal = (v: string | undefined) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n !== 0 ? n : undefined;
};

/** "2.5Gbps" / "1Gbps" / "100Mbps" → Mbps */
export function rateMbps(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/([\d.]+)\s*([GMk])/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  return unit === "G" ? n * 1000 : unit === "M" ? n : n / 1000;
}
