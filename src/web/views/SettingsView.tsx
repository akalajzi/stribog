import { useEffect, useState } from "react";
import { connectAdGuard, createToken, disconnectAdGuard, fetchAudit, fetchIntegrations, getTheme, listTokens, revokeToken, setTheme, type AuditEntry, type IntegrationsInfo, type NetworkPayload, type SessionInfo, type Theme, type TokenInfo } from "../api.ts";
import "./settings.css";

export function SettingsView({ data, session }: { data: NetworkPayload; session: SessionInfo }) {
  return (
    <div className="page settings">
      <h1>Settings</h1>
      <Appearance />
      <Integrations />
      <Agents demo={session.kind === "demo"} />
      <History data={data} />
    </div>
  );
}

function Appearance() {
  const [theme, set] = useState<Theme>(getTheme());
  const pick = (t: Theme) => {
    set(t);
    setTheme(t);
  };
  return (
    <section className="card st-sec">
      <h2>Appearance</h2>
      <div className="seg" role="radiogroup" aria-label="Theme">
        {(["dark", "light", "system"] as const).map((t) => (
          <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? "on" : undefined} onClick={() => pick(t)}>
            {t === "system" ? "Same as the computer" : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <p className="faint">Kept in this browser only.</p>
    </section>
  );
}

/** Other sources Stribog can read when you connect them: for now, AdGuard Home's query log. */
function Integrations() {
  const [info, setInfo] = useState<IntegrationsInfo>();
  const [error, setError] = useState<string>();
  const [form, setForm] = useState({ address: "", user: "", password: "" });
  const [busy, setBusy] = useState(false);
  const load = () => fetchIntegrations().then(setInfo, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const a = info?.adguard;
  useEffect(() => {
    if (a?.suggested && !form.address) setForm((f) => ({ ...f, address: a.suggested!.address }));
  }, [a?.suggested?.address]);

  const connect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await connectAdGuard(form.address, form.user, form.password);
      setForm((f) => ({ ...f, password: "" }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <section className="card st-sec">
      <h2>Integrations</h2>
      <p>
        Other things on your network that know what devices do. Stribog reads them when you connect them and shows what they know beside what the router reports. It does not change their settings.
      </p>
      <div className="st-int">
        <div className="st-int-h">
          <b>AdGuard Home</b>
          <span className={a?.connected && !a.error ? "ok" : "faint"}>{!a ? "" : a.sample ? "sample log" : a.connected ? (a.error ? "connected, last read failed" : "connected") : "not connected"}</span>
        </div>
        <p className="faint">
          Its query log says which names each device looks up: what an app or a gadget is talking to, before any traffic flows, and what the block lists stopped. Stribog also uses its answers to name the
          addresses in a device's traffic.
        </p>
        {!a ? null : a.sample ? (
          <p className="faint">The demo network reads a sample of a query log built into Stribog.</p>
        ) : a.connected ? (
          <>
            <div className="kv">
              <span>Address</span>
              <span className="tx mono">{a.url}{a.encrypted ? "" : <span className="cert">not encrypted</span>}</span>
              <span>Signed in as</span>
              <span className="tx">{a.user}</span>
              {a.version && <><span>Version</span><span className="tx mono">{a.version}</span></>}
            </div>
            {a.error && <p className="st-error">{a.error}</p>}
            <p className="faint">The password stays in Stribog's memory, like the router's: after Stribog restarts, connect again.</p>
            <div><button className="btn ghost sm" onClick={() => void disconnectAdGuard().then(load, (e: Error) => setError(e.message))}>Disconnect</button></div>
          </>
        ) : (
          <form
            className="st-form"
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <label>
              <span>Address</span>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="e.g. 192.168.1.10 or http://adguard.lan:3000" required />
            </label>
            <label>
              <span>User name</span>
              <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} autoComplete="username" required />
            </label>
            <label>
              <span>Password</span>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" />
            </label>
            <div className="st-form-foot">
              <button className="btn pri" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
              {a.suggested && (
                <span className="faint">
                  The router tells devices to ask {a.suggested.name ? <b>{a.suggested.name}</b> : null} <span className="mono">{a.suggested.ip}</span> for names: probably this one{a.suggested.address !== a.suggested.ip ? ", at the address in its notes" : ""}. The password
                  stays in Stribog's memory only.
                </span>
              )}
            </div>
          </form>
        )}
        {error && <p className="st-error">{error}</p>}
      </div>
    </section>
  );
}

function Agents({ demo }: { demo: boolean }) {
  const [tokens, setTokens] = useState<TokenInfo[]>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ token: string; name: string }>();
  const endpoint = `${location.origin}/mcp`;

  const load = () => listTokens().then(setTokens, (e: Error) => setError(e.message));
  useEffect(() => {
    if (!demo) void load();
  }, [demo]);

  const create = async () => {
    try {
      const { token, info } = await createToken(name || "Agent");
      setFresh({ token, name: info.name });
      setName("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card st-sec">
      <h2>Agents</h2>
      <p>
        Connect an AI agent to this network over MCP. It sees what Stribog reads from the router, including the review, and can read and write notes about devices, the same as you. Every change to notes is
        kept in the history below.
      </p>
      <div className="kv">
        <span>MCP address</span>
        <span className="tx mono">{endpoint}</span>
        <span>Sign-in</span>
        <span className="tx">A token, sent as <span className="mono">Authorization: Bearer …</span></span>
      </div>
      {demo ? (
        <p className="faint">Sign in to your router to connect an agent; the demo network has no tokens.</p>
      ) : (
        <>
          {fresh && (
            <div className="st-fresh">
              <b>Token for “{fresh.name}”</b>
              <p className="faint">Copy it now: Stribog keeps only a fingerprint and cannot show it again.</p>
              <Copyable text={fresh.token} />
              <p className="faint">For Claude Code, for example:</p>
              <Copyable text={`claude mcp add --transport http stribog ${endpoint} --header "Authorization: Bearer ${fresh.token}"`} />
            </div>
          )}
          <form
            className="st-new"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. the agent or the computer it runs on" maxLength={60} />
            <button className="btn pri">Create token</button>
          </form>
          {error && <p className="st-error">{error}</p>}
          {tokens && tokens.length > 0 && (
            <table className="st-table">
              <thead>
                <tr><th>Name</th><th>Created</th><th>Last used</th><th /></tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="faint">{when(t.createdAt)}</td>
                    <td className="faint">{t.lastUsedAt ? when(t.lastUsedAt) : "never"}</td>
                    <td><button className="btn ghost sm" onClick={() => void revokeToken(t.id).then(load, (e: Error) => setError(e.message))}>Revoke</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function History({ data }: { data: NetworkPayload }) {
  const [log, setLog] = useState<AuditEntry[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetchAudit(100).then(setLog, (e: Error) => setError(e.message));
  }, [data.meta.refreshedAt]);
  const nameOf = (target: string) => {
    if (target === "network") return "The network";
    const mac = target.replace(/^device:/, "");
    return data.model.devices.find((d) => d.mac === mac)?.name ?? mac;
  };
  return (
    <section className="card st-sec">
      <h2>History</h2>
      {error ? <p className="st-error">{error}</p> : !log ? null : !log.length ? <p className="faint">No notes have changed yet.</p> : (
        <ul className="st-log">
          {log.map((e, i) => (
            <li key={i}>
              <span className="faint mono">{when(e.at)}</span>
              <b>{nameOf(e.target)}</b>
              <span>{describe(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "name: NAS → Family NAS; labels added" in plain words. */
function describe(e: AuditEntry): string {
  const b = (e.before ?? {}) as Record<string, unknown>;
  const a = (e.after ?? {}) as Record<string, unknown>;
  if (!e.before) return "notes added";
  if (!e.after) return "notes removed";
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k !== "updatedAt" && JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  return (
    keys
      .map((k) => {
        const short = (v: unknown) => (typeof v === "string" ? (v.length > 40 ? `“${v.slice(0, 38)}…”` : `“${v}”`) : Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : JSON.stringify(v));
        if (b[k] === undefined) return `${k} set to ${short(a[k])}`;
        if (a[k] === undefined) return `${k} cleared`;
        return `${k}: ${short(b[k])} → ${short(a[k])}`;
      })
      .join("; ") || "no visible change"
  );
}

function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="st-copy">
      <code className="mono">{text}</code>
      <button
        className="btn sm"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
        }
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
