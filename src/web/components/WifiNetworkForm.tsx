import { useState } from "react";
import { applyWifi, ChangeError, previewWifi, type Ssid, type Step, type WifiPreview } from "../api.ts";
import { securityOf } from "../../core/change.ts";
import { nameProblem, passwordProblem, SECURITY_NAME, type Security } from "../../core/wifi-setup.ts";
import { CliBlock } from "./FindingCard.tsx";
import { WifiQr } from "./PendingBar.tsx";

// One Wi-Fi network's name, password and security. Like every change: the exact change first,
// then apply; the router undoes it by itself unless it is kept (the bar at the bottom).

type State =
  | { at: "edit" }
  | { at: "checking" }
  | { at: "confirm"; plan: WifiPreview }
  | { at: "applying" }
  | { at: "applied"; steps: Step[]; ssid: string; password?: string }
  | { at: "failed"; error: string; steps: Step[] };

const SECURITY_HINT: Record<Security, string> = {
  wpa2: "Works with everything; solid with a long password.",
  "wpa2-wpa3": "Newer devices use WPA3, older ones WPA2. The usual choice.",
  wpa3: "Strongest, but devices from before about 2019 cannot join.",
};

export function WifiNetworkForm({ s, canChange }: { s: Ssid; canChange: boolean }) {
  const current = securityOf(s.auth);
  const [name, setName] = useState(s.name);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [security, setSecurity] = useState<Security | undefined>(current === "other" ? undefined : current);
  const [st, setSt] = useState<State>({ at: "edit" });

  const edit = { ssid: s.name, name: name !== s.name ? name : undefined, password: password || undefined, security: security !== current ? security : undefined };
  const changed = !!(edit.name || edit.password || edit.security);
  const problem = (edit.name !== undefined && nameProblem(name)) || (password && passwordProblem(password)) || undefined;
  const reset = () => {
    setName(s.name);
    setPassword("");
    setSecurity(current === "other" ? undefined : current);
    setSt({ at: "edit" });
  };

  const check = async () => {
    setSt({ at: "checking" });
    try {
      setSt({ at: "confirm", plan: await previewWifi(edit) });
    } catch (e) {
      setSt({ at: "failed", error: (e as Error).message, steps: [] });
    }
  };
  const apply = async () => {
    setSt({ at: "applying" });
    try {
      const r = await applyWifi(edit);
      setSt({ at: "applied", steps: r.steps, ssid: name, password: edit.password });
    } catch (e) {
      setSt({ at: "failed", error: (e as Error).message, steps: e instanceof ChangeError ? e.steps : [] });
    }
  };

  if (st.at === "applied")
    return (
      <div className="card wf-form">
        <div className="wf-form-h"><b>{st.ssid}</b></div>
        <Steps steps={st.steps} />
        <p>Check that your devices are back on <b>{st.ssid}</b>, then press <b>Keep</b> in the bar at the bottom of the page.</p>
        {st.password && (
          <div className="wf-qr">
            <WifiQr ssid={st.ssid} password={st.password} />
            <p className="faint">Scan with a phone's camera to join {st.ssid}. The code is drawn here from what you typed; Stribog does not keep the password.</p>
          </div>
        )}
        <div className="pz-actions"><button className="btn ghost" onClick={reset}>Done</button></div>
      </div>
    );

  return (
    <div className="card wf-form">
      <div className="wf-form-h">
        <b>{s.name}</b>
        <span className="faint">{s.clients} device{s.clients === 1 ? "" : "s"}</span>
      </div>
      <fieldset disabled={!canChange || st.at !== "edit"} className="wf-fields">
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} spellCheck={false} />
        </label>
        <label>
          <span>New password</span>
          <span className="wf-pw">
            <input type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave empty to keep the current one" autoComplete="new-password" spellCheck={false} />
            <button type="button" className="btn sm ghost" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
          </span>
        </label>
        <div className="wf-field">
          <span>Security</span>
          <span>
            <span className="seg" role="radiogroup" aria-label="Security">
              {(Object.keys(SECURITY_NAME) as Security[]).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={security === k} className={security === k ? "on" : undefined} onClick={() => setSecurity(k)}>{SECURITY_NAME[k]}</button>
              ))}
            </span>
            <span className="faint wf-hint">{security ? SECURITY_HINT[security] : "It uses another kind of security now; pick one to change it."}</span>
          </span>
        </div>
      </fieldset>
      {problem && <p className="dv-error">{problem}</p>}
      {!canChange && <p className="faint">Sign in to the router to change the Wi-Fi.</p>}

      {st.at === "edit" && changed && !problem && (
        <div className="pz-actions">
          <button className="btn pri" onClick={() => void check()}>Review change…</button>
          <button className="btn ghost" onClick={reset}>Cancel</button>
        </div>
      )}
      {st.at === "checking" && <p className="faint">Reading the router's Wi-Fi settings…</p>}
      {st.at === "confirm" && (
        <div className="pz-confirm">
          <ul className="pz-why">{st.plan.summary.map((x) => <li key={x}>{x}</li>)}</ul>
          <p>Stribog will make these changes on the router:</p>
          <CliBlock code={st.plan.lines.join("\n")} />
          {st.plan.notes.map((n) => <p key={n} className="faint">{n}</p>)}
          <div className="pz-actions">
            <button className="btn pri" onClick={() => void apply()}>Change it</button>
            <button className="btn ghost" onClick={() => setSt({ at: "edit" })}>Back</button>
          </div>
        </div>
      )}
      {st.at === "applying" && <p className="faint">Changing… (a safety undo goes on the router first)</p>}
      {st.at === "failed" && (
        <div className="pz-done">
          <p className="dv-error">{st.error}</p>
          <Steps steps={st.steps} />
          <div className="pz-actions"><button className="btn ghost" onClick={() => setSt({ at: "edit" })}>Back</button></div>
        </div>
      )}
    </div>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <ul className="pz-steps">
      {steps.map((x, i) => (
        <li key={i} className={x.ok ? undefined : "bad"}>
          <span aria-hidden>{x.ok ? "✓" : "✕"}</span> {x.text}
        </li>
      ))}
    </ul>
  );
}
