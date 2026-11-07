import { useEffect, useState } from "react";
import { changePause, fetchPausePlan, fetchResumePlan, type Device, type PausePlan, type Step } from "../api.ts";
import { CliBlock } from "./FindingCard.tsx";

// Pausing a device's internet, the one change Stribog makes to the router itself. Every change
// goes the same way: show exactly what will change, confirm, apply, and show what the router
// reports back.

type State =
  | { at: "idle" }
  | { at: "loading" }
  | { at: "confirm"; what: "pause"; plan: PausePlan }
  | { at: "confirm"; what: "resume"; commands: string[] }
  | { at: "applying"; what: "pause" | "resume" }
  | { at: "done"; what: "pause" | "resume"; ok: boolean; steps: Step[]; error?: string }
  | { at: "error"; error: string };

/** "2026-11-07T14:32Z" as a local time, with the day when it is not today. */
function since(iso?: string): string | undefined {
  const t = iso ? new Date(iso.endsWith("Z") ? iso : `${iso}Z`) : undefined;
  if (!t || Number.isNaN(t.getTime())) return undefined;
  const today = t.toDateString() === new Date().toDateString();
  return t.toLocaleString(undefined, today ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" });
}

export function PauseControl({ d, canChange }: { d: Device; canChange: boolean }) {
  const [st, setSt] = useState<State>({ at: "idle" });
  // Another device starts over.
  useEffect(() => setSt({ at: "idle" }), [d.id]);

  const start = async (what: "pause" | "resume") => {
    setSt({ at: "loading" });
    try {
      if (what === "pause") setSt({ at: "confirm", what, plan: await fetchPausePlan(d.id) });
      else setSt({ at: "confirm", what, commands: (await fetchResumePlan(d.id)).commands });
    } catch (e) {
      setSt({ at: "error", error: (e as Error).message });
    }
  };
  const apply = async (what: "pause" | "resume") => {
    setSt({ at: "applying", what });
    const r = await changePause(d.id, what).catch((e: Error) => ({ ok: false, steps: [] as Step[], error: e.message }));
    setSt({ at: "done", what, ok: r.ok, steps: r.steps, error: r.error });
  };

  const when = since(d.paused?.since);
  return (
    <section className={`card dv-sec pz${d.paused ? " on" : ""}`}>
      <div className="pz-head">
        <div>
          <h2>{d.paused ? "Internet paused" : "Internet"}</h2>
          <p className="faint">
            {d.paused
              ? `${when ? `Since ${when}. ` : ""}It cannot reach the internet, nor be reached from it. It still has the local network: DNS, the devices at home, and you looking at it.`
              : "Pause its internet while you look into something: it keeps the local network, and you can resume it at any time."}
          </p>
        </div>
        {(st.at === "idle" || st.at === "error" || st.at === "done") && canChange && (
          <button className="btn" onClick={() => void start(d.paused ? "resume" : "pause")}>
            {d.paused ? "Resume internet…" : "Pause internet…"}
          </button>
        )}
      </div>
      {!canChange && <p className="faint">Sign in to the router to pause a device.</p>}
      {st.at === "loading" && <p className="faint">Reading the router's firewall…</p>}
      {st.at === "error" && <p className="dv-error">{st.error}</p>}

      {st.at === "confirm" && st.what === "pause" && (
        <div className="pz-confirm">
          <p>Stribog will add {st.plan.rules.length === 1 ? "this rule" : `these ${st.plan.rules.length} rules`} at the top of the router's firewall, then check them as the router reports them:</p>
          <ul className="pz-why">{st.plan.rules.map((r, i) => <li key={i}>{r.why}</li>)}</ul>
          <CliBlock code={st.plan.commands.join("\n")} />
          {st.plan.notes.map((n) => <p key={n} className="faint">{n}</p>)}
          <p className="faint">To undo it by hand: <code className="mono">{st.plan.undo[0]}</code>{st.plan.undo.length > 1 ? ` (and ${st.plan.undo.length - 1} more like it)` : ""}</p>
          <div className="pz-actions">
            <button className="btn pri" onClick={() => void apply("pause")}>Pause internet</button>
            <button className="btn ghost" onClick={() => setSt({ at: "idle" })}>Cancel</button>
          </div>
        </div>
      )}
      {st.at === "confirm" && st.what === "resume" && (
        <div className="pz-confirm">
          <p>Stribog will remove its pause rules for this device, then check that none are left:</p>
          <CliBlock code={st.commands.join("\n")} />
          <div className="pz-actions">
            <button className="btn pri" onClick={() => void apply("resume")}>Resume internet</button>
            <button className="btn ghost" onClick={() => setSt({ at: "idle" })}>Cancel</button>
          </div>
        </div>
      )}
      {st.at === "applying" && <p className="faint">{st.what === "pause" ? "Pausing…" : "Resuming…"}</p>}
      {st.at === "done" && (
        <div className="pz-done">
          {st.error && <p className="dv-error">{st.error}</p>}
          <ul className="pz-steps">
            {st.steps.map((s, i) => (
              <li key={i} className={s.ok ? undefined : "bad"}>
                <span aria-hidden>{s.ok ? "✓" : "✕"}</span> {s.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
