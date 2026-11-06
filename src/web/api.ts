import { useCallback, useEffect, useState } from "react";
import type { NetworkPayload } from "../server/provider.ts";

export type { NetworkPayload };
export type { Analysis, Finding, Severity, Category } from "../core/analyze.ts";
export type { Device, NetworkModel, Port, Network, Ssid, Radio } from "../core/model.ts";
export type { Layout, LNode, LLink } from "../core/layout.ts";

export function useNetwork() {
  const [data, setData] = useState<NetworkPayload>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/network${refresh ? "?refresh" : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body as NetworkPayload);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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
