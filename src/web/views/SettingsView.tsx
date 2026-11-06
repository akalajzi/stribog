import { useEffect, useState } from "react";
import { createToken, fetchAudit, getTheme, listTokens, revokeToken, setTheme, type AuditEntry, type NetworkPayload, type SessionInfo, type Theme, type TokenInfo } from "../api.ts";
import "./settings.css";

export function SettingsView({ data, session }: { data: NetworkPayload; session: SessionInfo }) {
  return (
    <div className="page settings">
      <h1>Settings</h1>
      <Appearance />
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
