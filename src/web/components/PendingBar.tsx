import { useEffect, useState } from "react";
import { encode } from "uqr";
import { ChangeError, fetchPending, settleChange, type PendingInfo, type Step } from "../api.ts";

// A change waiting to be kept, on every page: the router puts the old settings back when the time
// is up, so the person who made it keeps it from wherever they are once they are back.

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function PendingBar() {
  const [list, setList] = useState<PendingInfo[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ text: string; ok: boolean }>();

  useEffect(() => {
    let live = true;
    const load = () => fetchPending().then((l) => live && setList(l), () => {});
    void load();
    const t = setInterval(load, 5000);
    addEventListener("stribog:change-pending", load);
    return () => {
      live = false;
      clearInterval(t);
      removeEventListener("stribog:change-pending", load);
    };
  }, []);
  useEffect(() => {
    if (!list.length) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [list.length]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(undefined), 6000);
    return () => clearTimeout(t);
  }, [done]);

  const settle = async (p: PendingInfo, how: "keep" | "undo") => {
    setBusy(true);
    try {
      const r = await settleChange(p.token, how);
      setDone({ text: r.steps.map((s: Step) => s.text).join(" "), ok: true });
    } catch (e) {
      setDone({ text: (e as ChangeError).message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const p = list[0];
  if (!p) return done ? <div className={`pending-bar${done.ok ? "" : " bad"}`} role="status">{done.text}</div> : null;
  const left = p.deadline - now;
  return (
    <div className="pending-bar" role="alert">
      <div>
        <b>{p.title} changed. Keep it?</b>
        <span className="faint">
          {left > 0 ? <>The router puts the old settings back in <span className="mono">{mmss(left)}</span> unless you keep it.</> : "Time is up: the router is putting the old settings back."}
          {p.summary.length ? ` ${p.summary.join(" ")}` : ""}
        </span>
      </div>
      <button className="btn pri" disabled={busy || left <= 0} onClick={() => void settle(p, "keep")}>Keep</button>
      <button className="btn" disabled={busy} onClick={() => void settle(p, "undo")}>Undo now</button>
    </div>
  );
}

/** Wi-Fi as a QR code phones join by scanning: drawn here, from what was just typed. */
export function WifiQr({ ssid, password, size = 168 }: { ssid: string; password: string; size?: number }) {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
  const { data, size: n } = encode(`WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`, { ecc: "M", border: 2 });
  const cell = size / n;
  const path = data.flatMap((row, y) => row.map((on, x) => (on ? `M${x * cell} ${y * cell}h${cell}v${cell}h${-cell}z` : ""))).join("");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`QR code to join ${ssid}`} className="wifi-qr">
      <rect width={size} height={size} fill="#fff" rx={6} />
      <path d={path} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}
