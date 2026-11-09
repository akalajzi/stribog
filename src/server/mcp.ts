// MCP for agents: the network as Stribog reads it, the review, and notes they can write.
// Stateless Streamable HTTP at /mcp; the caller authenticates like any API client.

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { KINDS } from "../core/classify.ts";
import { connectionsOf, type Device, type NetworkModel } from "../core/model.ts";
import { normMac } from "../core/net.ts";
import { NotesError, type NotesStore } from "./notes.ts";
import { snapshotOf, type NetworkPayload } from "./provider.ts";
import { adviceRequest } from "../core/advice.ts";
import { isOpen, statusLine } from "../core/analyze.ts";
import type { DeviceActivity } from "./device-activity.ts";
import type { InternetHistory } from "./internet.ts";
import { WHERE_TEXT } from "../core/internet.ts";

export interface McpContext {
  network: () => Promise<NetworkPayload | undefined>;
  notes: NotesStore;
  activity: (id: string, hours: number) => Promise<DeviceActivity | undefined>;
  internet: (hours: number) => Promise<InternetHistory | undefined>;
}

const INSTRUCTIONS = `Stribog shows a MikroTik home network as read from its router, plus notes that people and agents add.
Facts marked "inferred" are Stribog's guesses (from names or the MAC vendor); "read" comes from the router; "user" comes from notes.
Use notes to record what the router cannot know: a device's real name and kind, labels, a short description, the services it runs, and free-form notes. Every change is logged.
Stribog does not change the router. Its review only diagnoses; to help fix a finding, read get_fix_request for it (the finding, the configuration involved and what a good answer contains) and advise the owner, who applies any change themselves.`;

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown, ctx: McpContext) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST", "content-type": "application/json" }).end(JSON.stringify({ error: "Stribog's MCP endpoint is stateless: POST only." }));
    return;
  }
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

const deviceNotesShape = {
  name: z.string().nullable().optional().describe("What people call it. null clears."),
  kind: z.enum(KINDS as [string, ...string[]]).nullable().optional().describe("Device type, used for its icon and checks."),
  labels: z.array(z.string()).nullable().optional().describe("Short tags such as a room, an owner or a role. Replaces the list."),
  description: z.string().nullable().optional().describe("One or two sentences: what it is and what it is for."),
  services: z
    .array(z.object({ name: z.string(), port: z.number().int().optional(), protocol: z.string().optional(), url: z.string().optional(), note: z.string().optional() }))
    .nullable()
    .optional()
    .describe("What runs on it. Replaces the list."),
  notes: z.string().nullable().optional().describe("Free-form notes. Replaces the text."),
  only24: z.boolean().nullable().optional().describe("Hardware that can only use 2.4 GHz, so being on 2.4 GHz is expected."),
  sameAs: z.string().nullable().optional().describe("MAC of another connection of the same machine (e.g. its Wi-Fi when this is its cable): the two show as one device."),
  separate: z.boolean().nullable().optional().describe("Not the same machine as others with the same DHCP name, which Stribog otherwise shows as one device."),
};

function buildServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "stribog", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: false };
  const network = async () => {
    const p = await ctx.network();
    if (!p) throw new NotesError("Stribog has not read the router yet. Someone needs to sign in to the Stribog app once.");
    return p;
  };
  const guard =
    <A>(fn: (a: A) => Promise<ReturnType<typeof json>>) =>
    async (a: A) => {
      try {
        return await fn(a);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };

  server.registerTool(
    "get_network_overview",
    { title: "Network overview", description: "The network at a glance: router, internet connection, networks and DHCP, Wi-Fi names, access points, device counts, the review's status, and how fresh the data is.", annotations: read },
    guard(async () => json(overview(await network(), ctx.notes.get().notes))),
  );

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description: "Every device the router knows about, with where it is connected and its notes. Filter by status or by text in the name, IP, MAC, hostname, labels or description.",
      inputSchema: { status: z.enum(["online", "offline", "any"]).optional().describe("Default: any."), query: z.string().optional() },
      annotations: read,
    },
    guard(async ({ status, query }: { status?: string; query?: string }) => {
      const { model } = await network();
      const q = query?.toLowerCase().trim();
      const list = model.devices
        .filter((d) => d.mac || d.id === model.routerId)
        .filter((d) => !status || status === "any" || d.status === status)
        .filter((d) => !q || [d.name, d.ip, d.mac, d.hostname, d.description, ...(d.labels ?? []), ...connectionsOf(d).flatMap((l) => [l.ip, l.mac])].some((x) => x?.toLowerCase().includes(q)));
      return json(list.map((d) => brief(d, model)));
    }),
  );

  server.registerTool(
    "get_device",
    {
      title: "Get device",
      description: "One device in full: identity, connection, what Stribog read or inferred about it, its notes, and review findings that mention it. Find it by MAC, IP or exact name.",
      inputSchema: { device: z.string().describe("MAC address, IP address or name.") },
      annotations: read,
    },
    guard(async ({ device }: { device: string }) => {
      const p = await network();
      const d = findDevice(p.model, device);
      if (!d) return fail(`No device matches “${device}”. Use list_devices to see what exists.`);
      const findings = p.analysis.findings.filter((f) => isOpen(f) && f.devices?.includes(d.id)).map((f) => ({ id: f.id, severity: f.severity, title: f.title, summary: f.summary }));
      return json({ ...brief(d, p.model), vendor: d.vendor, model: d.model, version: d.version, reserved: d.reserved, leaseComment: d.leaseComment, lastSeen: d.lastSeen, facts: d.facts, findings });
    }),
  );

  server.registerTool(
    "get_device_activity",
    {
      title: "Device activity",
      description:
        "Who a device talks to and how much: its top talkers by network owner (e.g. Apple, Google, Cloudflare, from an offline ASN database), its connections through the router right now (other end, DNS or reverse-DNS name when known, the network's owner, port and what the port is usually for, bytes each way), what it talked to over the last hours as recorded, its traffic and online history, and, when AdGuard Home is connected in Stribog, the domains it looked up (with what the block lists stopped). Only routed traffic is visible (internet and between networks), not traffic between devices on the same LAN. Useful to work out what an unknown device is; say it is a guess when you do.",
      inputSchema: { device: z.string().describe("MAC address, IP address or name."), hours: z.number().int().min(1).max(720).optional().describe("How far back, default 24.") },
      annotations: read,
    },
    guard(async ({ device, hours }: { device: string; hours?: number }) => {
      const p = await network();
      const d = findDevice(p.model, device);
      if (!d) return fail(`No device matches “${device}”. Use list_devices to see what exists.`);
      const a = await ctx.activity(d.id, hours ?? 24);
      if (!a) return fail("No activity available for this device.");
      const s = a.history.samples;
      const step = s.length > 1 ? (s.at(-1)![0] - s[0]![0]) / (s.length - 1) : 60_000;
      const peak = s.reduce((m, x) => Math.max(m, x[2] ?? 0, x[3] ?? 0), 0);
      return json({
        device: a.device,
        topOwners: { now: a.owners.now, recorded: a.owners.recorded, ownersKnown: a.owners.ready },
        now: { at: a.now.at, note: a.now.note, noNames: a.now.noNames, flows: a.now.flows.slice(0, 40) },
        recorded: {
          from: new Date(a.history.from).toISOString(),
          to: new Date(a.history.to).toISOString(),
          recording: a.history.recording,
          since: a.history.since,
          samples: s.length,
          onlineShare: s.length ? Math.round((s.filter((x) => x[1]).length / s.length) * 100) / 100 : undefined,
          bytesDown: Math.round(s.reduce((t, x) => t + ((x[2] ?? 0) * step) / 8000, 0)),
          bytesUp: Math.round(s.reduce((t, x) => t + ((x[3] ?? 0) * step) / 8000, 0)),
          peakBps: peak,
          talks: a.history.talks.slice(0, 40),
        },
        lookedUp: a.dns && { ...a.dns, from: new Date(a.dns.from).toISOString(), to: new Date(a.dns.to).toISOString(), domains: a.dns.domains.slice(0, 40).map((d) => ({ ...d, names: d.names.slice(0, 5) })) },
      });
    }),
  );

  server.registerTool(
    "get_internet_health",
    {
      title: "Internet health",
      description:
        "Whether the internet connection works and how it did over the last hours: once a minute the router pings its provider's gateway and two public addresses (1.1.1.1, 8.8.8.8). Gives the state now, outages and stretches of lost packets with where the fault probably was (the link to the provider's box, no address, the provider's box, the provider's network, or the router not answering), and round-trip times to the internet and to the gateway. 'Probably' in a place means it is inferred from which addresses answered.",
      inputSchema: { hours: z.number().int().min(1).max(720).optional().describe("How far back, default 168 (a week).") },
      annotations: read,
    },
    guard(async ({ hours }: { hours?: number }) => {
      const h = await ctx.internet(hours ?? 168);
      if (!h) return fail("Stribog has not read the router yet.");
      const iso = (t: number) => new Date(t).toISOString();
      return json({
        from: iso(h.from),
        to: iso(h.to),
        recording: h.recording,
        since: h.since,
        gateway: h.gateway,
        now: h.now && { at: iso(h.now.t), state: h.now.s, where: h.now.w && WHERE_TEXT[h.now.w].long },
        minutes: h.minutes,
        roundTripMs: { internet: h.latency, gateway: h.gatewayLatency },
        episodes: h.episodes.slice(0, 50).map((e) => ({ state: e.state, from: iso(e.from), to: iso(e.to), minutes: Math.round((e.to - e.from) / 60_000), ongoing: e.ongoing, where: e.where && WHERE_TEXT[e.where].long })),
      });
    }),
  );

  server.registerTool(
    "update_device_notes",
    {
      title: "Update device notes",
      description: "Add or change notes for a device, by MAC address. Only the fields you pass change; pass null to clear one. Lists (labels, services) are replaced as a whole. Works for devices that are offline or not seen yet.",
      inputSchema: { mac: z.string().describe("The device's MAC address."), ...deviceNotesShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ mac, ...patch }: { mac: string } & Record<string, unknown>) => json({ mac: normMac(mac), notes: ctx.notes.updateDevice(mac, stripUndefined(patch)) })),
  );

  server.registerTool(
    "update_network_notes",
    {
      title: "Update network notes",
      description: "Name the network, describe the internet provider and its box, or keep free-form notes about the whole network. null clears a field.",
      inputSchema: {
        site: z.string().nullable().optional().describe("Name of the network, e.g. the household or office."),
        upstream: z.object({ name: z.string().optional(), model: z.string().optional(), isp: z.string().optional() }).nullable().optional().describe("The ISP's box in front of the router."),
        notes: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async (patch: Record<string, unknown>) => {
      const n = ctx.notes.updateNetwork(stripUndefined(patch));
      return json({ site: n.site, upstream: n.upstream, notes: n.notes });
    }),
  );

  server.registerTool(
    "get_review",
    {
      title: "Review findings",
      description:
        "Stribog's review of the setup: what is fragile or wrong, worst first, with evidence. Diagnosis only, no fixes: use get_fix_request with a finding's id for everything needed to advise on fixing it. Findings the owner accepted are listed apart and do not count. Ideas (severity \"suggestion\") are optional and never change the status.",
      inputSchema: { includePassed: z.boolean().optional().describe("Also list what is already good.") },
      annotations: read,
    },
    guard(async ({ includePassed }: { includePassed?: boolean }) => {
      const { analysis } = await network();
      return json({
        status: analysis.status,
        summary: statusLine(analysis),
        counts: analysis.counts,
        findings: analysis.findings.filter((f) => !f.accepted && (includePassed || f.severity !== "pass")),
        accepted: analysis.findings.filter((f) => f.accepted).map((f) => ({ id: f.id, title: f.title, ...f.accepted })),
      });
    }),
  );

  server.registerTool(
    "accept_finding",
    {
      title: "Accept a review finding",
      description:
        "Mark a finding as accepted because it is fine on this network (\"nobody uses that device\", \"we do not want a guest network\"). It stops counting until it changes. Do this only when the owner says so, and give their reason. Logged like any note.",
      inputSchema: { finding: z.string().describe("The finding's id, from get_review."), reason: z.string().optional().describe("Why it is fine here, in the owner's words.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ finding, reason }: { finding: string; reason?: string }) => {
      const f = (await network()).analysis.findings.find((x) => x.id === finding);
      if (!f || f.severity === "pass") return fail(`No finding “${finding}” to accept. Use get_review to see the current ones.`);
      ctx.notes.acceptFinding(finding, f.title, reason);
      return json({ accepted: finding, title: f.title, reason });
    }),
  );

  server.registerTool(
    "reopen_finding",
    {
      title: "Reopen an accepted finding",
      description: "Make an accepted finding count again.",
      inputSchema: { finding: z.string().describe("The finding's id.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ finding }: { finding: string }) => (ctx.notes.reopenFinding(finding), json({ reopened: finding }))),
  );

  // Advice on a finding: the agent gets the context, Stribog never writes the fix itself.
  const request = async (id: string) => {
    const p = await network();
    const f = p.analysis.findings.find((x) => x.id === id);
    const snap = snapshotOf(p);
    if (!f) throw new NotesError(`No finding “${id}”. Use get_review to see the current ones.`);
    if (!snap) throw new NotesError("Stribog has no configuration to show for this finding right now; try again in a moment.");
    return adviceRequest({ finding: f, model: p.model, snap, notes: snap.notes ?? ctx.notes.get() });
  };

  server.registerTool(
    "get_fix_request",
    {
      title: "Fix request for a finding",
      description:
        "Everything needed to advise on one review finding: the finding and its evidence, the network, the devices involved, the owner's notes, the RouterOS configuration the check read (secrets hidden), and what a good answer contains (is it real here, options, exact commands, how to verify and undo, lockout risk). Read it, then advise the owner; Stribog applies nothing.",
      inputSchema: { finding: z.string().describe("The finding's id, from get_review.") },
      annotations: read,
    },
    guard(async ({ finding }: { finding: string }) => ({ content: [{ type: "text" as const, text: await request(finding) }] })),
  );

  server.registerPrompt(
    "fix_finding",
    {
      title: "Fix a review finding",
      description: "Advice on fixing one of Stribog's review findings, with the network's configuration as context.",
      argsSchema: { finding: z.string().describe("The finding's id, as shown in Stribog's review.") },
    },
    async ({ finding }: { finding: string }) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: await request(finding) } }] }),
  );

  server.registerTool(
    "get_change_log",
    { title: "Change log", description: "Recent changes to notes, newest first, with before and after.", inputSchema: { limit: z.number().int().min(1).max(500).optional() }, annotations: read },
    guard(async ({ limit }: { limit?: number }) => json(ctx.notes.audit(limit ?? 50))),
  );

  return server;
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function findDevice(m: NetworkModel, q: string): Device | undefined {
  const s = q.trim();
  const mac = normMac(s);
  const any = connectionsOf;
  return m.devices.find((d) => any(d).some((l) => l.mac === mac)) ?? m.devices.find((d) => any(d).some((l) => l.ip === s)) ?? m.devices.find((d) => d.name.toLowerCase() === s.toLowerCase());
}

function brief(d: Device, m: NetworkModel) {
  const parent = d.parent ? m.devices.find((x) => x.id === d.parent) : undefined;
  return {
    mac: d.mac,
    name: d.name,
    nameFrom: d.nameSource,
    kind: d.kind,
    kindFrom: d.kindCertainty,
    status: d.status,
    ip: d.ip,
    hostname: d.hostname,
    network: d.network,
    connection: d.via
      ? { via: d.via.kind, to: parent?.name, port: d.via.port, ssid: d.via.ssid, band: d.via.band, signalDbm: d.via.signal, certainty: d.via.certainty }
      : undefined,
    otherConnections: d.links?.slice(1).map((l) => ({
      mac: l.mac,
      ip: l.ip,
      status: l.status,
      via: l.via?.kind,
      to: m.devices.find((x) => x.id === l.parent)?.name,
      port: l.via?.port,
      ssid: l.via?.ssid,
      band: l.via?.band,
    })),
    sameMachineBecause: d.linkedBy && (d.linkedBy === "user" ? "notes say so" : "the same DHCP name (inferred)"),
    labels: d.labels,
    description: d.description,
    services: d.services,
    notes: d.notes,
  };
}

function overview(p: NetworkPayload, networkNotes?: string) {
  const { model: m, analysis: a, meta } = p;
  const router = m.devices.find((d) => d.id === m.routerId);
  const people = m.devices.filter((d) => d.mac && !d.managed);
  return {
    site: m.site,
    data: { mode: meta.mode, readAt: meta.refreshedAt, stale: meta.stale ?? false, note: meta.error },
    router: router && { name: router.name, model: router.model, version: router.version, ip: router.ip },
    internet: { type: m.wan.type, address: m.wan.address, gateway: m.wan.gateway, doubleNat: m.wan.doubleNat, upstream: m.devices.find((d) => d.id === "upstream")?.name },
    networks: m.networks.map((n) => ({ id: n.id, label: n.label, role: n.role, cidr: n.cidr, vlan: n.vlan, dhcp: n.dhcp && { pool: n.dhcp.pool, dns: n.dhcp.dns }, wifi: n.ssids })),
    wifi: m.ssids.map((s) => ({ ssid: s.name, bands: s.bands, network: s.network, clients: s.clients })),
    accessPoints: m.devices.filter((d) => d.kind === "ap" && d.managed).map((d) => ({ name: d.name, mac: d.mac, ip: d.ip, status: d.status, model: d.model, version: d.version })),
    ports: m.ports.map((x) => ({ name: x.name, zone: x.zone, speedMbps: x.speedMbps, poeWatts: x.poeWatts, devices: x.deviceIds.map((id) => m.devices.find((d) => d.id === id)?.name ?? id) })),
    devices: { total: people.length, online: people.filter((d) => d.status === "online").length },
    review: { status: a.status, summary: statusLine(a), counts: a.counts },
    notes: networkNotes,
  };
}
