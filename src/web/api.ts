import { useCallback, useEffect, useState } from "react";
import type { NetworkPayload } from "../server/provider.ts";
import type { SessionInfo } from "../server/server.ts";

export type { NetworkPayload, SessionInfo };
export type { Analysis, Finding, Severity, Category } from "../core/analyze.ts";
export type { Device, NetworkModel, Port, Network, Ssid, Radio } from "../core/model.ts";
export type { Layout, LNode, LLink } from "../core/layout.ts";

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

  return { data, error, loading, reload: () => load(true) };
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
