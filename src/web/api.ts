import { useCallback, useEffect, useMemo, useState } from "react";
import { applyRates, type LiveRates } from "../core/live.ts";
import { layoutTopology } from "../core/layout.ts";
import type { NetworkPayload } from "../server/provider.ts";
import type { IntegrationsInfo, SessionInfo } from "../server/server.ts";
import type { DeviceActivity } from "../server/device-activity.ts";

export type { NetworkPayload, SessionInfo, DeviceActivity, IntegrationsInfo };
export type { Analysis, Finding, Severity, Category } from "../core/analyze.ts";
export type { Device, NetworkModel, Port, Network, Ssid, Radio } from "../core/model.ts";
export type { Layout, LNode, LLink } from "../core/layout.ts";

/** Merge notes for a device; null clears a field. Resolves to an error message, or undefined. */
export async function saveDeviceNotes(mac: string, patch: Record<string, unknown>): Promise<string | undefined> {
  const res = await fetch(`/api/notes/devices/${encodeURIComponent(mac)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (res.ok) return undefined;
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
}

export interface TokenInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}
export interface AuditEntry {
  at: string;
  target: string;
  before: unknown;
  after: unknown;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
export const listTokens = () => api<TokenInfo[]>("/api/tokens");
export const createToken = (name: string) => api<{ token: string; info: TokenInfo }>("/api/tokens", { method: "POST", body: JSON.stringify({ name }) });
export const revokeToken = (id: string) => api<{ ok: true }>(`/api/tokens/${id}`, { method: "DELETE" });
export const fetchActivity = (id: string, hours: number) => api<DeviceActivity>(`/api/devices/${encodeURIComponent(id)}/activity?hours=${hours}`);
export const fetchIntegrations = () => api<IntegrationsInfo>("/api/integrations");
export const connectAdGuard = (body: { address: string; user?: string; password?: string; sameAs?: string }) => api<{ ok: true }>("/api/integrations/adguard", { method: "POST", body: JSON.stringify(body) });
export const disconnectAdGuard = (url: string) => api<{ ok: true }>(`/api/integrations/adguard?url=${encodeURIComponent(url)}`, { method: "DELETE" });
export const fetchFixRequest = (id: string) => api<{ text: string }>(`/api/review/${encodeURIComponent(id)}/request`).then((r) => r.text);
export const acceptFinding = (id: string, reason?: string) => api<{ ok: true }>(`/api/review/${encodeURIComponent(id)}/accept`, { method: "PUT", body: JSON.stringify({ reason }) });
export const reopenFinding = (id: string) => api<{ ok: true }>(`/api/review/${encodeURIComponent(id)}/accept`, { method: "DELETE" });
export const fetchAudit = (limit = 100) => api<AuditEntry[]>(`/api/notes/audit?limit=${limit}`);

export type Theme = "dark" | "light" | "system";
export const getTheme = (): Theme => (localStorage.getItem("stribog-theme") as Theme | null) ?? "dark";
/** Applies the theme to the page; "system" follows the operating system. */
export function applyTheme(t: Theme = getTheme()) {
  const light = t === "light" || (t === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
}
export function setTheme(t: Theme) {
  localStorage.setItem("stribog-theme", t);
  applyTheme(t);
}

const post = (path: string, body?: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

export function useSession() {
  const [info, setInfo] = useState<SessionInfo>();
  const [error, setError] = useState<string>();
  /** Why the last session ended, when the server ended it. */
  const [ended, setEnded] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/session");
      setInfo((await res.json()) as SessionInfo);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Resolves to an error message, or undefined when signed in. */
  const signIn = useCallback(
    async (address: string, user: string, password: string): Promise<string | undefined> => {
      const res = await post("/api/login", { address, user, password });
      if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
      setEnded(undefined);
      await refresh();
    },
    [refresh],
  );
  const demo = useCallback(async () => {
    await post("/api/demo");
    setEnded(undefined);
    await refresh();
  }, [refresh]);
  const signOut = useCallback(
    async (reason?: string) => {
      await post("/api/logout");
      setEnded(reason);
      await refresh();
    },
    [refresh],
  );
  return { info, error, ended, signIn, demo, signOut };
}

export function useNetwork(onSignedOut: (reason: string) => void) {
  const [data, setData] = useState<NetworkPayload>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/network${refresh ? "?refresh" : ""}`);
      const body = await res.json();
      if (res.status === 401) return onSignedOut(body.error ?? "Signed out.");
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body as NetworkPayload);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live mode refreshes on its own.
  useEffect(() => {
    if (data?.meta.mode !== "live") return;
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [data?.meta.mode, load]);

  return { data, error, loading, reload: () => load(true), refetch: () => load() };
}

/** Tiny hash router: #/map?d=mac:..  */
export function useRoute(): [string, URLSearchParams, (path: string, params?: Record<string, string>) => void] {
  const parse = () => {
    const [p, q] = (location.hash.replace(/^#/, "") || "/").split("?");
    return [p || "/", new URLSearchParams(q ?? "")] as const;
  };
  const [state, setState] = useState(parse);
  useEffect(() => {
    const on = () => setState(parse());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = (path: string, params?: Record<string, string>) => {
    const q = params ? new URLSearchParams(params).toString() : "";
    location.hash = q ? `${path}?${q}` : path;
  };
  return [state[0], state[1], go];
}

/** How often traffic is read between full reads. */
export const LIVE_MS = 2000;

/**
 * The network with traffic read every couple of seconds (live routers only, while the page is
 * visible). Full reads still come every 15 seconds; in between only the numbers move.
 */
export function useLiveRates(data: NetworkPayload | undefined, on: boolean): NetworkPayload | undefined {
  const [rates, setRates] = useState<LiveRates>();
  const live = on && data?.meta.mode === "live" && !data.meta.stale;
  useEffect(() => {
    if (!live) return;
    let busy = false;
    let stop = false;
    const tick = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const res = await fetch("/api/live");
        const r = res.ok ? ((await res.json()) as LiveRates | null) : null;
        if (!stop && r) setRates(r);
      } catch {
        // The next full read will say what is wrong.
      } finally {
        busy = false;
      }
    };
    void tick();
    const t = setInterval(tick, LIVE_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [live]);
  return useMemo(() => {
    if (!data || !live || !rates || rates.at < Date.parse(data.meta.refreshedAt)) return data;
    const model = applyRates(data.model, rates);
    return { ...data, model, layout: layoutTopology(model) };
  }, [data, rates, live]);
}
