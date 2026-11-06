import { useState, type FormEvent } from "react";
import type { SessionInfo } from "../api.ts";
import { Logo } from "../components/Logo.tsx";
import "./login.css";

export function Login({ login, ended, onSignIn, onDemo }: { login: NonNullable<SessionInfo["login"]>; ended?: string; onSignIn: (address: string, user: string, password: string) => Promise<string | undefined>; onDemo: () => void }) {
  const [address, setAddress] = useState(login.address);
  const [user, setUser] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(await onSignIn(address, user, password).catch((err: unknown) => (err instanceof Error ? err.message : String(err))));
    setBusy(false);
  };

  return (
    <div className="login">
      <form className="login-card card" onSubmit={submit}>
        <div className="login-brand">
          <Logo />
          <b>Stribog</b>
        </div>
        <h1>Sign in to your router</h1>
        <p className="muted">
          Use the same user name and password as for WinBox or WebFig. Stribog keeps them in memory while you are signed in and never writes them to disk.
        </p>
        {ended && <p className="login-note">{ended}</p>}

        <label className="login-field">
          <span>Router</span>
          {login.addressFixed ? (
            <span className="mono login-fixed">{login.address}</span>
          ) : (
            <>
              <input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="url" spellCheck={false} required />
              <small>Filled in with this computer's gateway, which is usually the router.</small>
            </>
          )}
        </label>
        <label className="login-field">
          <span>User name</span>
          <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" spellCheck={false} required />
        </label>
        <label className="login-field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
          <small>A router that was never set up has its password on the label underneath.</small>
        </label>

        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="btn pri login-go" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <button type="button" className="btn ghost login-demo" onClick={onDemo}>No router at hand? Explore the demo network</button>
      </form>
    </div>
  );
}
