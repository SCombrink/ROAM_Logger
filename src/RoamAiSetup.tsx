import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SpinnerIcon } from "./icons";

// Switching on ROAM AI: a one-time sign-in with a (free) GitHub account,
// led by the app. ROAM AI's engine (GitHub's Copilot CLI) is installed in the
// background; the sign-in opens GitHub in a small in-app window with the
// one-time code already filled in. See copilot.rs.

interface Colors { border: string; text: string; text_muted: string; primary: string; input_bg: string; surface: string; card_bg: string; modal_bg: string; modal_overlay: string }

/** GitHub's sign-in page for a one-time code (the manual route). */
const DEVICE_LINK = "https://github.com/login/device";

type Step =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; code: string; manual: boolean }
  | { kind: "finishing" }
  | { kind: "no-copilot"; detail: string }
  | { kind: "error"; message: string };

export function RoamAiSetup({ colors, onReady, gemini, problem }: {
  colors: Colors;
  /** A "NO_COPILOT: ..." found after sign-in, to start on that step */
  problem?: string | null;
  /** Called with the GitHub user name once ROAM AI answers */
  onReady: (login: string) => void;
  /** The old Gemini key entry, offered as a fallback */
  gemini: ReactNode;
}) {
  const [step, setStep] = useState<Step>(() => problem?.startsWith("NO_COPILOT:") ? { kind: "no-copilot", detail: problem.slice(11).trim() } : { kind: "idle" });
  useEffect(() => {
    if (problem?.startsWith("NO_COPILOT:")) setStep({ kind: "no-copilot", detail: problem.slice(11).trim() });
  }, [problem]);
  const [setup, setSetup] = useState<{ stage: string; percent: number | null } | null>(null);
  const [showGemini, setShowGemini] = useState(false);
  const [copied, setCopied] = useState("");
  /** The manual-route instructions pop-up. */
  const [showManual, setShowManual] = useState(false);
  const alive = useRef(true);
  /** Bumped per sign-in, so a cancelled one can't change the screen. */
  const attempt = useRef(0);

  useEffect(() => {
    alive.current = true;
    const un = listen<{ stage: string; percent: number | null }>("roam-ai-setup", e => setSetup(e.payload));
    return () => { alive.current = false; un.then(f => f()); };
  }, []);

  const finish = (p: Promise<string>, mine = attempt.current) =>
    p.then(login => { if (alive.current && mine === attempt.current) onReady(login); })
      .catch(e => {
        if (!alive.current || mine !== attempt.current) return;
        const msg = String(e);
        if (msg === "CANCELLED") setStep({ kind: "idle" });
        else if (msg.startsWith("NO_COPILOT:")) setStep({ kind: "no-copilot", detail: msg.slice(11).trim() });
        else setStep({ kind: "error", message: msg.replace(/^(EXPIRED|SIGN_IN|QUOTA):\s*/, "") });
      });

  /** manual: the user's own browser instead of the in-app window. */
  const start = async (manual = false) => {
    const mine = ++attempt.current;
    setStep({ kind: "starting" });
    try {
      const d = await invoke<{ userCode: string; verificationUri: string }>("roam_ai_sign_in_start", { inApp: !manual });
      if (!alive.current || mine !== attempt.current) return;
      setStep({ kind: "waiting", code: d.userCode, manual });
      if (manual) { void copy(DEVICE_LINK, "link"); setShowManual(true); }
      await finish(invoke<string>("roam_ai_sign_in_wait").then(login => { setStep({ kind: "finishing" }); return login; }), mine);
    } catch (e) {
      if (alive.current && mine === attempt.current) setStep({ kind: "error", message: String(e) });
    }
  };
  // A fresh sign-in (new code, new window): the old window may be closed,
  // or the old code used up.
  const restart = async (manual = false) => { await invoke("roam_ai_sign_in_cancel").catch(() => {}); void start(manual); };
  // From the in-app window to the manual route: same code, the app keeps waiting.
  const goManual = () => {
    void invoke("roam_ai_close_sign_in_window");
    void copy(DEVICE_LINK, "link");
    if (step.kind === "waiting") setStep({ ...step, manual: true });
    setShowManual(true);
  };
  const cancel = () => { attempt.current++; void invoke("roam_ai_sign_in_cancel"); setStep({ kind: "idle" }); };
  const recheck = () => { setStep({ kind: "finishing" }); void finish(invoke<string>("roam_ai_check")); };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); window.setTimeout(() => setCopied(c => (c === what ? "" : c)), 2000); } catch { /* ignore */ }
  };

  const btn = { padding: "6px 12px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "12px", fontWeight: "bold" as const, cursor: "pointer" };
  const primary = { ...btn, borderColor: colors.primary, backgroundColor: colors.primary, color: "#FFFFFF" };
  const muted = { fontSize: "12px", color: colors.text_muted, lineHeight: 1.45 };
  const installing = setup && (setup.stage === "downloading" || setup.stage === "installing");

  return (
    <div role="region" aria-label="Switch on ROAM AI" style={{ marginBottom: "16px", padding: "12px", backgroundColor: colors.card_bg, border: `1px solid ${colors.border}`, borderLeft: `4px solid ${colors.primary}`, borderRadius: "8px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ fontWeight: "bold", fontSize: "14px" }}>Switch on ROAM AI</div>

      {step.kind === "idle" && (<>
        <div style={muted}>ROAM AI turns what you type or say into a filled-in observation. Sign in once with a GitHub account to switch it on. It's free, and you can create an account in the same window.</div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => start()} style={primary}>Sign in to switch on ROAM AI</button>
          <button type="button" onClick={() => start(true)} style={btn} title="If GitHub blocks sign-up or sign-in in the app's window">Use my own browser instead</button>
          {installing && <span style={{ ...muted, display: "flex", alignItems: "center", gap: "6px" }}><SpinnerIcon size={12} /> Getting ROAM AI ready{setup?.percent != null ? ` ${setup.percent}%` : "..."}</span>}
        </div>
      </>)}

      {step.kind === "starting" && <div style={{ ...muted, display: "flex", alignItems: "center", gap: "6px" }}><SpinnerIcon size={12} /> Opening the sign-in window...</div>}

      {step.kind === "waiting" && (<>
        <div style={muted}>{step.manual ? "Finish in your own browser (see the steps). Your code:" : "A sign-in window has opened. Your code is filled in for you:"}</div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span aria-label="Your one-time code" style={{ fontFamily: "Consolas, monospace", fontSize: "22px", fontWeight: "bold", letterSpacing: "3px", padding: "4px 10px", border: `1px dashed ${colors.border}`, borderRadius: "4px", userSelect: "all" }}>{step.code}</span>
          <button type="button" onClick={() => copy(step.code, "code")} style={btn}>{copied === "code" ? "Copied" : "Copy code"}</button>
        </div>
        {!step.manual && <ol style={{ ...muted, margin: 0, paddingLeft: "18px" }}>
          <li>Sign in to GitHub, or choose <strong>Create an account</strong> (free).</li>
          <li>Check the code matches, and press <strong>Continue</strong>.</li>
          <li>Press <strong>Authorize</strong>. The window closes and ROAM AI switches on.</li>
        </ol>}
        <div style={{ padding: "8px 10px", border: `1px solid ${colors.border}`, borderRadius: "6px", backgroundColor: colors.surface, display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ ...muted, color: colors.text }}>
            {step.manual
              ? <>Open this link in a <strong>private window</strong>, another browser or your phone, and enter the code there:</>
              : <><strong>GitHub blocked the sign-up or sign-in</strong> (for example "unusual activity")? Use the manual route: open this link in your own private window or another browser.</>}
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <code style={{ fontSize: "12px", padding: "3px 6px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, userSelect: "all" }}>{DEVICE_LINK}</code>
            <button type="button" onClick={goManual} style={step.manual ? btn : primary}>{copied === "link" ? "Link copied" : "Copy link"}</button>
            <button type="button" onClick={() => setShowManual(true)} style={{ border: "none", background: "none", padding: 0, color: colors.text_muted, fontFamily: "inherit", fontSize: "11px", textDecoration: "underline", cursor: "pointer" }}>How do I do this?</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ ...muted, display: "flex", alignItems: "center", gap: "6px", marginRight: "auto" }}><SpinnerIcon size={12} /> {step.manual ? "Waiting for you to finish in your browser..." : "Waiting for you to finish in the window..."}</span>
          {step.manual
            ? <button type="button" onClick={() => restart(true)} style={btn}>Get a new code</button>
            : <button type="button" onClick={() => restart()} style={btn}>Open the window again</button>}
          <button type="button" onClick={cancel} style={btn}>Cancel</button>
        </div>
      </>)}

      {step.kind === "finishing" && (
        <div style={{ ...muted, display: "flex", alignItems: "center", gap: "6px" }}><SpinnerIcon size={12} /> {installing ? `Getting ROAM AI ready${setup?.percent != null ? ` ${setup.percent}%` : "..."}` : "Switching on ROAM AI..."}</div>
      )}

      {step.kind === "no-copilot" && (<>
        <div style={muted}>You're signed in, but GitHub Copilot isn't on for this account yet. Turn on <strong>Copilot Free</strong> in the window that opens (one click), then press <strong>Try again</strong>.</div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button type="button" onClick={() => invoke("roam_ai_open_copilot_settings")} style={primary}>Turn on Copilot Free</button>
          <button type="button" onClick={recheck} style={btn}>Try again</button>
          <button type="button" onClick={() => start()} style={btn}>Use another account</button>
        </div>
        {step.detail && <div style={{ ...muted, fontSize: "11px" }}>Details: {step.detail}</div>}
      </>)}

      {step.kind === "error" && (<>
        <div role="alert" style={{ fontSize: "12px", color: "#CF222E", lineHeight: 1.45 }}>{step.message}</div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button type="button" onClick={() => start()} style={primary}>Try again</button>
          <button type="button" onClick={() => start(true)} style={btn}>Use my own browser instead</button>
        </div>
      </>)}

      <div>
        <button type="button" onClick={() => setShowGemini(v => !v)} aria-expanded={showGemini}
          style={{ border: "none", background: "none", padding: 0, color: colors.text_muted, fontFamily: "inherit", fontSize: "11px", textDecoration: "underline", cursor: "pointer" }}>
          {showGemini ? "Hide the Gemini key option" : "I have a Gemini API key instead"}
        </button>
      </div>
      {showGemini && gemini}
      {showManual && (
        <ManualRoute colors={colors} code={step.kind === "waiting" ? step.code : ""} copied={copied} copy={copy}
          onNewCode={() => { setShowManual(false); void restart(true); }} onClose={() => setShowManual(false)} />
      )}
    </div>
  );
}

/** Step-by-step instructions for signing in through the user's own browser. */
function ManualRoute({ colors, code, copied, copy, onNewCode, onClose }: {
  colors: Colors; code: string; copied: string;
  copy: (text: string, what: string) => Promise<void>;
  onNewCode: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const btn = { padding: "6px 12px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "12px", fontWeight: "bold" as const, cursor: "pointer" };
  const primary = { ...btn, borderColor: colors.primary, backgroundColor: colors.primary, color: "#FFFFFF" };
  const li = { marginBottom: "10px" };
  const chip = { fontFamily: "Consolas, monospace", padding: "2px 6px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, userSelect: "all" as const };
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000, padding: "20px" }}>
      <div role="dialog" aria-modal="true" aria-label="Sign in with your own browser"
        style={{ width: "100%", maxWidth: "500px", maxHeight: "calc(100vh - 40px)", overflowY: "auto", backgroundColor: colors.modal_bg, color: colors.text, border: `1px solid ${colors.border}`, borderTop: `4px solid ${colors.primary}`, borderRadius: "8px", boxShadow: "0 8px 30px rgba(0,0,0,0.35)", padding: "18px 20px", fontSize: "13px", lineHeight: 1.5 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: "17px" }}>Sign in with your own browser</h3>
        <div style={{ color: colors.text_muted, fontSize: "12px", marginBottom: "12px" }}>Use this if GitHub blocks the sign-up or sign-in in the app's window. Keep ROAM Logger open: it switches ROAM AI on by itself when you finish.</div>
        <ol style={{ margin: 0, paddingLeft: "20px" }}>
          <li style={li}><strong>Open a private window.</strong> In Edge or Chrome press <strong>Ctrl + Shift + N</strong> (Firefox: <strong>Ctrl + Shift + P</strong>). Another browser works too.</li>
          <li style={li}>
            <strong>Paste the link</strong> into the address bar (<strong>Ctrl + V</strong>) and press <strong>Enter</strong>. It is already copied:
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginTop: "4px" }}>
              <span style={chip}>{DEVICE_LINK}</span>
              <button type="button" onClick={() => copy(DEVICE_LINK, "link")} style={btn}>{copied === "link" ? "Copied" : "Copy link"}</button>
            </div>
          </li>
          <li style={li}><strong>Sign in to GitHub</strong>, or choose <strong>Create an account</strong> (free). If GitHub still says "unusual activity", do these steps on your <strong>phone using mobile data</strong> (not the office Wi-Fi).</li>
          <li style={li}>
            <strong>Enter this code</strong> and press <strong>Continue</strong>:
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginTop: "4px" }}>
              <span aria-label="Your one-time code" style={{ ...chip, fontSize: "20px", fontWeight: "bold", letterSpacing: "3px" }}>{code || "...."}</span>
              {code && <button type="button" onClick={() => copy(code, "code")} style={btn}>{copied === "code" ? "Copied" : "Copy code"}</button>}
            </div>
          </li>
          <li style={li}><strong>Press Authorize.</strong> Then come back here: ROAM AI switches on within a few seconds.</li>
        </ol>
        <div style={{ color: colors.text_muted, fontSize: "12px", margin: "4px 0 12px" }}>The code works for 15 minutes. If creating your account takes longer (for example waiting for GitHub's email), press <strong>Get a new code</strong> and enter the new one.</div>
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={onNewCode} style={btn}>Get a new code</button>
          <button type="button" onClick={onClose} style={primary} autoFocus>OK, I'll do that</button>
        </div>
      </div>
    </div>
  );
}
