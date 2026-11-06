import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNetwork, useRoute, useSession, type Finding, type NetworkPayload, type SessionInfo } from "./api.ts";
import { Logo } from "./components/Logo.tsx";
import { Login } from "./views/Login.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { DeviceView } from "./views/DeviceView.tsx";
import { Topology } from "./components/Topology.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { Overview } from "./views/Overview.tsx";
import { WifiView } from "./views/WifiView.tsx";
import { ClientsView } from "./views/ClientsView.tsx";
import { NetworkView } from "./views/NetworkView.tsx";
import { PlanView } from "./views/PlanView.tsx";

const NAV: { path: string; label: string; icon: ReactNode }[] = [
  { path: "/", label: "Review", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 3a9 9 0 1 0 9 9" /><path d="m8.5 12 2.5 2.5L20 5.5" /></svg> },
  { path: "/map", label: "Topology", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="5" r="2.2" /><circle cx="5" cy="18" r="2.2" /><circle cx="19" cy="18" r="2.2" /><circle cx="12" cy="13" r="2.2" /><path d="M12 7.2v3.6M10.3 14.5l-3.6 2.2M13.7 14.5l3.6 2.2" /></svg> },
  { path: "/wifi", label: "Wi-Fi", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 9.5a13 13 0 0 1 18 0M6 13a8 8 0 0 1 12 0M9 16.5a3.5 3.5 0 0 1 6 0" /><circle cx="12" cy="19.5" r=".8" fill="currentColor" /></svg> },
  { path: "/clients", label: "Clients", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="13" height="10" rx="1.5" /><rect x="15.5" y="9" width="5.5" height="10" rx="1.3" /><path d="M6 19h7" /></svg> },
  { path: "/network", label: "LAN & internet", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="5" rx="1.5" /><rect x="3" y="11" width="18" height="5" rx="1.5" opacity=".6" /><rect x="3" y="18" width="18" height="2.5" rx="1" opacity=".35" /></svg> },
  { path: "/plan", label: "New setup", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M5 4h14v16H5z" /><path d="M9 9h6M9 13h6M9 17h3" /></svg> },
];

export function App() {
  const session = useSession();
  const { info, signOut } = session;
  const onSignedOut = useCallback((reason: string) => void signOut(reason), [signOut]);

  if (!info)
    return (
      <div className="loading">
        {session.error ? <span style={{ color: "var(--bad)" }}>Could not reach Stribog's server: {session.error}</span> : <span className="pulse">Starting…</span>}
      </div>
    );
  if (!info.signedIn && info.login) return <Login login={info.login} ended={session.ended} onSignIn={session.signIn} onDemo={() => void session.demo()} />;
  return <Shell session={info} onSignOut={() => void signOut()} onSignedOut={onSignedOut} />;
}

function Shell({ session, onSignOut, onSignedOut }: { session: SessionInfo; onSignOut: () => void; onSignedOut: (reason: string) => void }) {
  const { data, error, loading, reload, refetch } = useNetwork(onSignedOut);
  const [path, params, go] = useRoute();

  if (!data)
    return (
      <div className="loading">
        {error ? <span style={{ color: "var(--bad)" }}>Could not load the network: {error}</span> : <span className="pulse">Reading the network…</span>}
      </div>
    );

  const warn = data.analysis.counts.warning + data.analysis.counts.critical;
  const showOnMap = (f: Finding) => go("/map", { hl: (f.devices ?? []).join(","), d: f.devices?.[0] ?? "" });

  return (
    <div className="app">
      <nav className="rail">
        <Logo className="logo" />
        {NAV.map((n) => (
          <a key={n.path} href={`#${n.path}`} className={`ri${path === n.path ? " on" : ""}`}>
            {n.icon}
            {n.path === "/" && warn > 0 && <span className="badge" />}
            <span className="tip">{n.label}</span>
          </a>
        ))}
        <div className="sp" />
        <a href="#/settings" className={`ri${path === "/settings" ? " on" : ""}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
          <span className="tip">Settings</span>
        </a>
        <button className="ri" title="Reload" onClick={reload}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={loading ? "pulse" : undefined}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></svg>
          <span className="tip">Reload</span>
        </button>
        {session.kind !== "files" && (
          <button className="ri" title={session.kind === "demo" ? "Leave the demo" : "Sign out"} onClick={onSignOut}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" /><path d="M10 8l-4 4 4 4M6 12h10" /></svg>
            <span className="tip">{session.kind === "demo" ? "Leave the demo" : "Sign out"}</span>
          </button>
        )}
      </nav>

      <TopBar data={data} session={session} />

      <main className="main">
        {path === "/map" ? (
          <MapView data={data} selected={params.get("d") || undefined} highlight={params.get("hl")?.split(",").filter(Boolean)} go={go} onNotesSaved={refetch} />
        ) : path === "/wifi" ? (
          <WifiView data={data} onSelect={(id) => go("/map", { d: id })} />
        ) : path === "/clients" ? (
          <ClientsView data={data} onSelect={(id) => go("/map", { d: id })} />
        ) : path === "/network" ? (
          <NetworkView data={data} onSelect={(id) => go("/map", { d: id })} />
        ) : path === "/plan" ? (
          <PlanView data={data} />
        ) : path === "/device" && params.get("d") ? (
          <DeviceView data={data} id={params.get("d")!} onBack={() => go("/map", { d: params.get("d")! })} onSelect={(id) => go("/device", { d: id })} />
        ) : path === "/settings" ? (
          <SettingsView data={data} session={session} />
        ) : (
          <Overview data={data} onShow={showOnMap} />
        )}
      </main>
    </div>
  );
}

function TopBar({ data, session }: { data: NetworkPayload; session: SessionInfo }) {
  const { model, analysis, meta } = data;
  const up = model.devices.find((d) => d.id === "upstream");
  const isp = up?.facts.find((f) => f.startsWith("ISP:"))?.replace("ISP: ", "");
  const lan = model.networks.find((n) => n.role === "lan");
  const health = analysis.counts.critical ? "bad" : analysis.counts.warning ? "warn" : "";
  return (
    <header className="top">
      <div className="site"><b>{model.site}</b><span className="faint mono" style={{ fontSize: 12 }}>{lan?.cidr}</span></div>
      <span className="pill"><span className={`dot ${health}`} />{analysis.counts.critical ? "Needs attention" : analysis.counts.warning ? `${analysis.counts.warning} to fix` : "Healthy"}<span className="faint">· score {analysis.score}</span></span>
      <span className="pill">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.4 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.4-3.6-8.5s1-5.9 3.6-8.5z" /></svg>
        {isp ?? "Internet"}{up ? ` via ${up.name.split(" ")[0]}` : ""}
        {model.wan.doubleNat === true && <span className="faint">· double NAT</span>}
      </span>
      <div className="grow" />
      {session.router && !session.router.encrypted && (
        <span className="pill warn" title="The router's https service (www-ssl) is off, so Stribog talks to it over plain http and the password crosses your network unencrypted on every read. Turning on www-ssl fixes this.">
          Not encrypted
        </span>
      )}
      {session.router && <span className="pill" title={session.router.url}>{session.user}<span className="faint">@ {session.router.identity ?? session.router.url.replace(/^https?:\/\//, "")}</span></span>}
      {meta.error && <span className="pill err" title={meta.error}>{meta.stale ? "Router not answering" : "Could not read the router"}</span>}
      {meta.mode === "live" ? (
        <span className="pill">{meta.stale ? <span className="dot warn" /> : <span className="dot pulse" />}Live · {new Date(meta.refreshedAt).toLocaleTimeString()}</span>
      ) : meta.sample ? (
        <span className="pill sample" title="Configuration is real (from exports); clients, signals and link speeds are sample data, not read from a router.">Real config · sample live data</span>
      ) : (
        <span className="pill">{meta.mode === "demo" ? "Demo network" : `From files · ${model.generatedAt}`}</span>
      )}
    </header>
  );
}

/** The inspector's width; it is drawn over the map, so opening it never resizes the map. */
const SIDE_W = 440;

function MapView({ data, selected, highlight, go, onNotesSaved }: { data: NetworkPayload; selected?: string; highlight?: string[]; go: (p: string, q?: Record<string, string>) => void; onNotesSaved: () => void }) {
  const [sel, setSel] = useState(selected);
  useEffect(() => setSel(selected), [selected]);
  const select = (id?: string) => {
    setSel(id);
    go("/map", id ? { d: id, ...(highlight?.length ? { hl: highlight.join(",") } : {}) } : {});
  };
  return (
    <div className={`mapwrap${sel ? "" : " noside"}`}>
      <Topology data={data} selected={sel} highlight={highlight} onSelect={select} covered={sel ? SIDE_W : 0} />
      {sel ? (
        <Inspector
          data={data}
          id={sel}
          onClose={() => select(undefined)}
          onSelect={(id) => select(id)}
          onNotesSaved={onNotesSaved}
          onDetails={(id) => go("/device", { d: id })}
          onFinding={(fid) => {
            go("/");
            setTimeout(() => document.getElementById(`f-${fid}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
          }}
        />
      ) : (
        <div />
      )}
      {highlight?.length ? (
        <div className="maptop">
          <span className="pill">Highlighting {highlight.length} device{highlight.length === 1 ? "" : "s"} from the review</span>
          <button className="btn sm" onClick={() => go("/map", sel ? { d: sel } : {})}>Clear</button>
        </div>
      ) : null}
    </div>
  );
}
