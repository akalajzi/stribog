// MCP for agents: the network as Stribog reads it, the review, and notes they can write.
// Stateless Streamable HTTP at /mcp; the caller authenticates like any API client.

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { KINDS } from "../core/classify.ts";
import type { Device, NetworkModel } from "../core/model.ts";
import { normMac } from "../core/net.ts";
import { NotesError, type NotesStore } from "./notes.ts";
import type { NetworkPayload } from "./provider.ts";

export interface McpContext {
  network: () => Promise<NetworkPayload | undefined>;
  notes: NotesStore;
}

const INSTRUCTIONS = `Stribog shows a MikroTik home network as read from its router, plus notes that people and agents add.
Facts marked "inferred" are Stribog's guesses (from names or the MAC vendor); "read" comes from the router; "user" comes from notes.
Use notes to record what the router cannot know: a device's real name and kind, labels, a short description, the services it runs, and free-form notes. Every change is logged.
Stribog does not change the router. Review findings include RouterOS scripts for a person to read and paste.`;

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
    { title: "Network overview", description: "The network at a glance: router, internet connection, networks and DHCP, Wi-Fi names, access points, device counts, review score, and how fresh the data is.", annotations: read },
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
        .filter((d) => !q || [d.name, d.ip, d.mac, d.hostname, d.description, ...(d.labels ?? [])].some((x) => x?.toLowerCase().includes(q)));
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
      const findings = p.analysis.findings.filter((f) => f.severity !== "pass" && f.devices?.includes(d.id)).map((f) => ({ id: f.id, severity: f.severity, title: f.title, summary: f.summary }));
      return json({ ...brief(d, p.model), vendor: d.vendor, model: d.model, version: d.version, reserved: d.reserved, leaseComment: d.leaseComment, lastSeen: d.lastSeen, facts: d.facts, findings });
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
      description: "Stribog's review of the setup: what is fragile and what to change, worst first, with evidence and a RouterOS fix script where the fix is on the router. Scripts are for a person to read and paste.",
      inputSchema: { includePassed: z.boolean().optional().describe("Also list what is already good.") },
      annotations: read,
    },
    guard(async ({ includePassed }: { includePassed?: boolean }) => {
      const { analysis } = await network();
      return json({
        score: analysis.score,
        grade: analysis.grade,
        counts: analysis.counts,
        findings: analysis.findings.filter((f) => includePassed || f.severity !== "pass"),
      });
    }),
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
  return m.devices.find((d) => d.mac === mac) ?? m.devices.find((d) => d.ip === s) ?? m.devices.find((d) => d.name.toLowerCase() === s.toLowerCase());
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
    review: { score: a.score, grade: a.grade, counts: a.counts },
    notes: networkNotes,
  };
}
