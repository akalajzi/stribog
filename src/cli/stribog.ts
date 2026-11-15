#!/usr/bin/env -S npx tsx
// Stribog on the command line: audit a network from files or a live router, collect a
// read-only snapshot, or start the web app. Nothing here changes anything on a router.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze, CATEGORY_LABEL, STATUS_LABEL, statusLine, type Analysis, type Finding, type Severity } from "../core/analyze.ts";
import { adviceRequest } from "../core/advice.ts";
import { expand, snapshotFromFiles, type StribogConfig } from "../core/load.ts";
import { buildModel, type NetworkModel } from "../core/model.ts";
import { RouterOsRest } from "../core/rest.ts";
import type { Snapshot } from "../core/ros.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const DEMO_CONFIG = resolve(ROOT, "fixtures/demo/stribog.config.json");

// ---------------------------------------------------------------------------
// Terminal styling: calm colours, off for NO_COLOR, pipes and dumb terminals.

const useColor = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!process.stdout.isTTY && process.env.TERM !== "dumb";
})();

const sgr = (open: string, close = "39") => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
const c = {
  bold: sgr("1", "22"),
  dim: sgr("2", "22"),
  italic: sgr("3", "23"),
  red: sgr("38;5;203"),
  amber: sgr("38;5;214"),
  blue: sgr("38;5;111"),
  grey: sgr("38;5;246"),
  green: sgr("38;5;114"),
  teal: sgr("38;5;80"),
};

const SEV: Record<Severity, { label: string; mark: string; color: (s: string) => string }> = {
  critical: { label: "Critical", mark: "◆", color: c.red },
  warning: { label: "Warnings", mark: "▲", color: c.amber },
  suggestion: { label: "Suggestions", mark: "●", color: c.blue },
  info: { label: "Notes", mark: "○", color: c.grey },
  pass: { label: "Already good", mark: "✓", color: c.green },
};
const ORDER: Severity[] = ["critical", "warning", "suggestion", "info", "pass"];

const width = () => Math.max(60, Math.min(process.stdout.columns || 96, 100));

function wrap(text: string, indent: number, max = width()): string {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && pad.length + line.length + 1 + word.length > max) {
        out.push(pad + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(pad + line);
  }
  return out.join("\n");
}

/** A wrapped list item whose continuation lines align with the text, not the bullet. */
const bullet = (mark: string, text: string, indent: number, max: number) => " ".repeat(indent) + mark + " " + wrap(text, indent + 2, max).slice(indent + 2);

// ---------------------------------------------------------------------------
// Commands

const HELP = `${c.bold("stribog")} ${c.dim("— a plain-English review of a MikroTik home network")}

${c.bold("Usage")}
  stribog audit [--config stribog.config.json] [--json] [--details]
  stribog audit --export router.rsc [--cap ap.rsc ...] [--state state.json] [--notes notes.json]
  stribog advise <finding-id> [--config … | --export …]
  stribog collect --url https://192.168.88.1 --user stribog [--password-file file] [--insecure] --out snapshot.json
  stribog serve [--port 4517] [--host 127.0.0.1]
  stribog help

${c.bold("audit")}
  Reads the network the same way the web app does: --config, else $STRIBOG_CONFIG, else
  ./stribog.config.json, else the built-in demo network. Prints where the setup stands and
  the findings grouped by severity. Ideas are optional and never change the status.
    --json        print the full analysis as JSON
    --details     include each finding's explanation and evidence
    --export      audit a single /export file without a config; add --cap for each access point
                  export and --state for runtime state JSON

${c.bold("advise")}
  Prints a request for advice on one finding, for an AI agent: the finding, the configuration
  it is about (secrets hidden), the owner's notes, and what a good answer contains. Stribog only
  diagnoses; the fix comes from the agent and is applied by you. Takes the same sources as audit.

${c.bold("collect")}
  Reads the router over the RouterOS REST API (GET and "monitor once" only) and writes a
  snapshot JSON. Point "snapshot" in stribog.config.json at it to audit it later.
  The password comes from --password-file or $STRIBOG_PASSWORD and is never printed.
  Any user that can read works; a read-only one is the safest choice:
    /user group add name=stribog-read policy=read,api,rest-api,!write,!policy,!sensitive
    /user add name=stribog group=stribog-read password=...

${c.bold("serve")}
  Starts the web app and API (run \`pnpm build\` once first).

Colours follow NO_COLOR / FORCE_COLOR and switch off when output is not a terminal.
`;

type Flags = Record<string, string | boolean | string[] | undefined>;

function fail(msg: string, code = 1): never {
  process.stderr.write(`${c.red("stribog:")} ${msg}\n`);
  process.exit(code);
}

async function main(argv: string[]) {
  const args = argv.filter((a) => a !== "--");
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string", short: "c" },
        json: { type: "boolean" },
        details: { type: "boolean" },
        export: { type: "string" },
        cap: { type: "string", multiple: true },
        state: { type: "string" },
        notes: { type: "string" },
        url: { type: "string" },
        user: { type: "string", short: "u" },
        "password-file": { type: "string" },
        insecure: { type: "boolean", short: "k" },
        out: { type: "string", short: "o" },
        port: { type: "string", short: "p" },
        host: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\nRun \`stribog help\` for usage.`, 2);
  }
  const [cmd = "help", ...rest] = parsed.positionals;
  const flags = parsed.values as Flags;
  if (flags.help || cmd === "help") return void process.stdout.write(HELP);
  if (cmd === "advise") {
    if (rest.length !== 1) fail("give one finding id, e.g. `stribog advise wan-double-nat` (ids are in `stribog audit --json`).", 2);
    return advise(flags, rest[0]!);
  }
  if (rest.length) fail(`unexpected argument${rest.length > 1 ? "s" : ""}: ${rest.join(" ")}`, 2);
  switch (cmd) {
    case "audit":
      return audit(flags);
    case "collect":
      return collect(flags);
    case "serve":
      return serve(flags);
    default:
      fail(`unknown command “${cmd}”. Try \`stribog help\`.`, 2);
  }
}

// ---- audit ----------------------------------------------------------------------

interface Loaded {
  model: NetworkModel;
  analysis: Analysis;
  label: string;
  demo: boolean;
  sample: boolean;
  error?: string;
  snap?: Snapshot;
}

async function load(flags: Flags): Promise<Loaded> {
  if (flags.export) {
    const cwd = process.cwd();
    const exists = (p: string) => existsSync(expand(p, cwd)) || fail(`file not found: ${p}`);
    const config: StribogConfig = {
      sources: [
        { role: "router", export: flags.export as string, state: flags.state as string | undefined },
        ...((flags.cap as string[] | undefined) ?? []).map((p) => ({ role: "cap" as const, export: p })),
      ],
      notes: flags.notes as string | undefined,
    };
    for (const s of config.sources!) [s.export, s.state].filter((p): p is string => !!p).forEach(exists);
    if (config.notes) exists(config.notes);
    const snap = snapshotFromFiles(config, cwd);
    const model = buildModel(snap);
    return { model, analysis: analyze(model, snap), label: flags.export as string, demo: false, sample: false, snap };
  }
  if (flags.state || flags.cap || flags.notes) fail("--cap, --state and --notes go with --export", 2);

  // Same path as the server, so the CLI and the web app always agree.
  if (flags.config) {
    const path = expand(flags.config as string);
    if (!existsSync(path)) fail(`config not found: ${flags.config}`);
    process.env.STRIBOG_CONFIG = path;
  }
  const { getNetwork, resolveConfigPath, snapshotOf } = await import("../server/provider.ts");
  const path = resolveConfigPath() ?? DEMO_CONFIG;
  const p = await getNetwork(undefined, true);
  const demo = p.meta.mode === "demo" || resolve(path) === DEMO_CONFIG;
  return { model: p.model, analysis: p.analysis, label: path, demo, sample: p.meta.sample, error: p.meta.error, snap: snapshotOf(p) };
}

async function advise(flags: Flags, id: string) {
  const loaded = await load(flags);
  const f = loaded.analysis.findings.find((x) => x.id === id);
  if (!f) fail(`no finding “${id}”. Current ones: ${loaded.analysis.findings.filter((x) => x.severity !== "pass").map((x) => x.id).join(", ")}`);
  process.stdout.write(adviceRequest({ finding: f, model: loaded.model, snap: loaded.snap!, notes: loaded.snap?.notes }) + "\n");
}

async function audit(flags: Flags) {
  const loaded = await load(flags);
  if (flags.json) {
    process.stdout.write(JSON.stringify(loaded.analysis, null, 2) + "\n");
    return;
  }
  process.stdout.write(report(loaded, !!flags.details));
}

function report({ model: m, analysis: a, label, demo, sample, error }: Loaded, details: boolean): string {
  const out: string[] = [];
  const w = width();
  const router = m.devices.find((d) => d.id === m.routerId);
  const people = m.devices.filter((d) => d.mac && !d.managed);
  const online = people.filter((d) => d.status === "online");
  const wifi = people.filter((d) => d.via?.kind === "wifi");
  const aps = m.devices.filter((d) => d.kind === "ap");

  const tag = demo ? c.teal(" demo network ") : sample ? c.amber(" sample state ") : "";
  out.push("");
  out.push(`  ${c.bold(m.site)}${tag ? "  " + tag : ""}`);
  const routerLine = router ? [router.name, router.model, router.version ? `RouterOS ${router.version}` : ""].filter(Boolean).join(" · ") : "no router in the data";
  out.push(c.dim(`  ${routerLine}`));
  const stats = [
    aps.length ? `${aps.length} access point${aps.length === 1 ? "" : "s"}` : "",
    `${people.length} device${people.length === 1 ? "" : "s"}`,
    m.hasState ? `${online.length} online, ${wifi.length} on Wi-Fi` : "configuration only",
    m.wan.address ? `WAN ${m.wan.address}${m.wan.doubleNat === true ? " (double NAT)" : ""}` : "",
  ].filter(Boolean);
  out.push(c.dim(`  ${stats.join(" · ")}`));
  const shown = label.startsWith("/") && !relative(process.cwd(), label).startsWith("..") ? relative(process.cwd(), label) : label;
  out.push(c.dim(`  from ${shown}`));
  if (error) out.push(c.amber(wrap(error, 2, w)));
  out.push("");

  const statusColor = a.status === "attention" ? c.red : a.status === "loose-ends" ? c.amber : c.green;
  out.push(`  ${statusColor(c.bold(STATUS_LABEL[a.status]))}  ${c.dim(statusLine(a))}`);
  const counts = ORDER.map((s) => {
    const n = a.counts[s];
    const lbl = s === "pass" ? "good" : s === "critical" ? "critical" : `${s === "info" ? "note" : s}${n === 1 ? "" : "s"}`;
    const txt = `${SEV[s].mark} ${n} ${lbl}`;
    return n ? SEV[s].color(txt) : c.dim(txt);
  });
  out.push(`  ${counts.join(c.dim("   "))}`);
  if (a.accepted) out.push(c.dim(`  ${a.accepted} accepted in notes, not counted: ${a.findings.filter((f) => f.accepted).map((f) => f.id).join(", ")}`));

  for (const sev of ORDER) {
    const group = a.findings.filter((f) => f.severity === sev && !f.accepted);
    if (!group.length) continue;
    out.push("");
    out.push(`  ${SEV[sev].color(c.bold(SEV[sev].label.toUpperCase()))}`);
    if (sev === "pass") {
      for (const f of group) out.push(`  ${SEV.pass.color(SEV.pass.mark)} ${f.title}`);
      continue;
    }
    for (const f of group) out.push(finding(f, details, w));
  }
  out.push("");
  if (!details) out.push(c.dim("  Run with --details for evidence. For how to fix one: stribog advise <id>, then give it to an AI agent.\n"));
  else out.push(c.dim("  For how to fix one: stribog advise <id>, then give it to an AI agent.\n"));
  return out.join("\n") + "\n";
}

function finding(f: Finding, details: boolean, w: number): string {
  const s = SEV[f.severity];
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${s.color(s.mark)} ${c.bold(f.title)}  ${c.dim(CATEGORY_LABEL[f.category])}  ${c.grey(f.id)}`);
  lines.push(wrap(f.summary, 4, w));
  if (details) {
    for (const d of f.detail ?? []) lines.push(c.dim(wrap(d, 4, w)));
    if (f.evidence?.length) {
      lines.push(`    ${c.dim("Evidence")}`);
      for (const e of f.evidence) lines.push(c.grey(bullet("·", e, 6, w)));
    }
  }
  return lines.join("\n");
}

// ---- collect --------------------------------------------------------------------

async function collect(flags: Flags) {
  const url = flags.url as string | undefined;
  const user = flags.user as string | undefined;
  if (!url || !/^https?:\/\//.test(url)) fail("collect needs --url http(s)://router", 2);
  if (!user) fail("collect needs --user (any RouterOS user that can read; a read-only one is enough)", 2);
  const pwFile = flags["password-file"] as string | undefined;
  let password = process.env.STRIBOG_PASSWORD ?? "";
  if (pwFile) {
    if (!existsSync(expand(pwFile))) fail(`password file not found: ${pwFile}`);
    password = readFileSync(expand(pwFile), "utf8").trim();
  }
  if (!password) fail("no password: use --password-file or set STRIBOG_PASSWORD", 2);
  const out = expand((flags.out as string | undefined) ?? "snapshot.json");
  process.stderr.write(c.dim(`Reading ${url} as ${user} (read-only)…\n`));
  let router;
  try {
    const rest = new RouterOsRest({ url, user, password, insecure: !!flags.insecure });
    // snapshot() treats every failing menu as absent, so check the login once first.
    await rest.get("/system/identity").catch((err: Error) => {
      if (/HTTP 401|HTTP 403/.test(err.message)) fail(`the router refused the login for “${user}” (wrong password, or the user lacks the api/rest-api policy).`);
      throw err;
    });
    router = await rest.snapshot();
  } catch (err) {
    const msg = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    fail(`could not read the router: ${msg.split(password).join("<hidden>")}`);
  }
  const menus = Object.values(router.config.menus).filter((r) => r.length).length;
  const state = Object.values(router.state ?? {}).filter((r) => r.length).length;
  if (!menus && !state) fail("the router answered, but every menu was empty or missing. Is the REST API (www/www-ssl) enabled, and does the user have the rest-api policy?");
  const snap: Snapshot = { collectedAt: new Date().toISOString(), devices: [router] };
  writeFileSync(out, JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 });
  const model = router.config.meta.model ?? "router";
  process.stderr.write(`${c.green("✓")} ${model}${router.config.meta.version ? ` · RouterOS ${router.config.meta.version}` : ""}: ${menus} config menus, ${state} state menus → ${out}\n`);
  process.stderr.write(c.dim(`  Audit it with: add "snapshot": "${out}" to stribog.config.json, then \`stribog audit\`.\n`));
}

// ---- serve ----------------------------------------------------------------------

function serve(flags: Flags) {
  const server = resolve(ROOT, "src/server/server.ts");
  if (!existsSync(resolve(ROOT, "dist/index.html"))) process.stderr.write(c.amber("The web app is not built yet; run `pnpm build` first (the API works without it).\n"));
  const env = { ...process.env };
  if (flags.port) env.PORT = flags.port as string;
  if (flags.host) env.HOST = flags.host as string;
  // Reuse the running TypeScript loader (tsx) for the child.
  const child = spawn(process.execPath, [...process.execArgv, server], { stdio: "inherit", env });
  const stop = (sig: NodeJS.Signals) => child.kill(sig);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

await main(process.argv.slice(2));
