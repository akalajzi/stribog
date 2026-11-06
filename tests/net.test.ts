import { describe, expect, it } from "vitest";
import {
  bandFromRos,
  bandOf,
  channelOf,
  cidrString,
  coveredChannels,
  freqOfChannel,
  inCidr,
  inPool,
  intToIp,
  ipToInt,
  isCgnatIp,
  isDfs,
  isPrivateIp,
  isPrivateMac,
  normMac,
  parseChannelStatus,
  parseCidr,
  parseSignal,
  poolSize,
  rateMbps,
} from "../src/core/net.ts";

describe("addresses", () => {
  it("converts between dotted quads and integers", () => {
    expect(ipToInt("192.168.50.1")).toBe(0xc0a83201);
    expect(ipToInt("255.255.255.255")).toBe(0xffffffff);
    expect(ipToInt("256.1.1.1")).toBeUndefined();
    expect(ipToInt("not an ip")).toBeUndefined();
    expect(intToIp(0xc0a83201)).toBe("192.168.50.1");
  });

  it("parses CIDR notation", () => {
    expect(parseCidr("192.168.50.1/24")).toEqual({ ip: "192.168.50.1", prefix: 24, network: 0xc0a83200, size: 256 });
    expect(parseCidr("10.0.0.7")).toMatchObject({ prefix: 32, size: 1 });
    expect(parseCidr("0.0.0.0/0")).toMatchObject({ network: 0, size: 2 ** 32 });
    expect(parseCidr("10.0.0.0/33")).toBeUndefined();
    expect(cidrString("192.168.50.1/24")).toBe("192.168.50.0/24");
    expect(cidrString("garbage")).toBe("garbage");
  });

  it("tests membership in a CIDR", () => {
    expect(inCidr("192.168.50.200", "192.168.50.0/24")).toBe(true);
    expect(inCidr("192.168.51.1", "192.168.50.0/24")).toBe(false);
    expect(inCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(inCidr("192.168.50.1", "192.168.50.1/32")).toBe(true);
    expect(inCidr("x", "10.0.0.0/8")).toBe(false);
  });

  it("knows private and CGNAT ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1"]) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["172.32.0.1", "203.0.113.47", "100.64.0.1", "8.8.8.8"]) expect(isPrivateIp(ip)).toBe(false);
    expect(isCgnatIp("100.64.0.1")).toBe(true);
    expect(isCgnatIp("100.127.255.254")).toBe(true);
    expect(isCgnatIp("100.128.0.1")).toBe(false);
    expect(isCgnatIp("192.168.1.1")).toBe(false);
  });

  it("counts and tests RouterOS pool ranges", () => {
    const pool = ["192.168.50.100-192.168.50.199", "192.168.50.239"];
    expect(poolSize(pool)).toBe(101);
    expect(poolSize(["10.0.0.0/30"])).toBe(4);
    expect(poolSize(["10.0.0.9-10.0.0.1"])).toBe(0);
    expect(inPool("192.168.50.150", pool)).toBe(true);
    expect(inPool("192.168.50.239", pool)).toBe(true);
    expect(inPool("192.168.50.200", pool)).toBe(false);
    expect(inPool("10.0.0.2", ["10.0.0.0/30"])).toBe(true);
    expect(inPool("nope", pool)).toBe(false);
  });
});

describe("MAC addresses", () => {
  it("normalises case and separators", () => {
    expect(normMac(" 00-00-5e-00-53-0a ")).toBe("00:00:5E:00:53:0A");
    expect(normMac(undefined)).toBe("");
  });

  it("recognises locally administered (private) MACs", () => {
    for (const m of ["02:00:5E:00:53:01", "3a:00:5e:00:53:60", "DA:A1:19:00:00:01", "F2:00:00:00:00:00"]) expect(isPrivateMac(m)).toBe(true);
    for (const m of ["00:00:5E:00:53:01", "00:11:32:00:00:01", "FC:00:00:00:00:00"]) expect(isPrivateMac(m)).toBe(false);
    expect(isPrivateMac("")).toBe(false);
    expect(isPrivateMac(undefined)).toBe(false);
  });
});

describe("Wi-Fi channels", () => {
  it("maps frequencies to channels and back", () => {
    expect(channelOf(2412)).toBe(1);
    expect(channelOf(2462)).toBe(11);
    expect(channelOf(2484)).toBe(14);
    expect(channelOf(5180)).toBe(36);
    expect(channelOf(5220)).toBe(44);
    expect(channelOf(5745)).toBe(149);
    expect(channelOf(5955)).toBe(1);
    expect(freqOfChannel("2.4", 6)).toBe(2437);
    expect(freqOfChannel("2.4", 14)).toBe(2484);
    expect(freqOfChannel("5", 100)).toBe(5500);
    expect(freqOfChannel("6", 5)).toBe(5975);
    for (const ch of [1, 6, 11, 13]) expect(channelOf(freqOfChannel("2.4", ch))).toBe(ch);
    for (const ch of [36, 52, 100, 149, 165]) expect(channelOf(freqOfChannel("5", ch))).toBe(ch);
  });

  it("knows bands and DFS", () => {
    expect(bandOf(2437)).toBe("2.4");
    expect(bandOf(5500)).toBe("5");
    expect(bandOf(6115)).toBe("6");
    expect(isDfs(36)).toBe(false);
    expect(isDfs(52)).toBe(true);
    expect(isDfs(144)).toBe(true);
    expect(isDfs(149)).toBe(false);
    expect(bandFromRos("2ghz-ax")).toBe("2.4");
    expect(bandFromRos("5ghz-n/ac")).toBe("5");
    expect(bandFromRos("6ghz-ax")).toBe("6");
    expect(bandFromRos(undefined)).toBeUndefined();
  });

  it("parses RouterOS channel status strings", () => {
    expect(parseChannelStatus("5220/ax/eeCe/I")).toEqual({ freq: 5220, channel: 44, band: "5", width: 80, dfs: false });
    expect(parseChannelStatus("2462/ax")).toEqual({ freq: 2462, channel: 11, band: "2.4", width: 20, dfs: false });
    expect(parseChannelStatus("5180/ax/Ce")).toMatchObject({ channel: 36, width: 40 });
    expect(parseChannelStatus("5500/ac/Ceeeeeee/D")).toMatchObject({ channel: 100, width: 160, dfs: true });
    expect(parseChannelStatus("2437/n/C")).toMatchObject({ channel: 6, width: 20 });
    expect(parseChannelStatus("")).toBeUndefined();
    expect(parseChannelStatus("auto")).toBeUndefined();
    expect(parseChannelStatus(undefined)).toBeUndefined();
  });

  it("lists the 20 MHz channels a transmission covers", () => {
    expect(coveredChannels("5", 44, 80)).toEqual([36, 40, 44, 48]);
    expect(coveredChannels("5", 36, 80)).toEqual([36, 40, 44, 48]);
    expect(coveredChannels("5", 40, 40)).toEqual([36, 40]);
    expect(coveredChannels("5", 44, 40)).toEqual([44, 48]);
    expect(coveredChannels("5", 100, 80)).toEqual([100, 104, 108, 112]);
    expect(coveredChannels("5", 157, 80)).toEqual([149, 153, 157, 161]);
    expect(coveredChannels("5", 64, 160)).toEqual([36, 40, 44, 48, 52, 56, 60, 64]);
    expect(coveredChannels("5", 52, 20)).toEqual([52]);
    expect(coveredChannels("2.4", 1, 20)).toEqual([1, 2, 3]);
    expect(coveredChannels("2.4", 6, 20)).toEqual([4, 5, 6, 7, 8]);
    expect(coveredChannels("2.4", 11, 20)).toEqual([9, 10, 11, 12, 13]);
  });

  it("puts two 80 MHz radios on 36 and 44 in the same block", () => {
    const a = coveredChannels("5", 36, 80);
    const b = coveredChannels("5", 44, 80);
    expect(a.filter((c) => b.includes(c))).toHaveLength(4);
  });
});

describe("parsing numbers", () => {
  it("parses signal strength", () => {
    expect(parseSignal("-58")).toBe(-58);
    expect(parseSignal("-71dBm")).toBe(-71);
    expect(parseSignal("")).toBeUndefined();
    expect(parseSignal(undefined)).toBeUndefined();
  });

  it("converts link rates to Mbps", () => {
    expect(rateMbps("2.5Gbps")).toBe(2500);
    expect(rateMbps("1Gbps")).toBe(1000);
    expect(rateMbps("100Mbps")).toBe(100);
    expect(rateMbps("10M")).toBe(10);
    expect(rateMbps("960.7Mbps")).toBeCloseTo(960.7);
    expect(rateMbps("500kbps")).toBe(0.5);
    expect(rateMbps(undefined)).toBeUndefined();
    expect(rateMbps("no-link")).toBeUndefined();
  });
});
