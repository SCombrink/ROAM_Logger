import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SpinnerIcon } from "./icons";

// Switching on ROAM AI: a one-time sign-in with a (free) GitHub account,
// led by the app. ROAM AI's engine (GitHub's Copilot CLI) is installed in the
// background; the sign-in opens GitHub in a small in-app window with the
// one-time code already filled in. See copilot.rs.

interface Colors { border: string; text: string; text_muted: string; primary: string; input_bg: string; surface: string; card_bg: string }

type Step =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; code: string }
  | { kind: "finishing" }
  | { kind: "no-copilot"; detail: string }
  | { kind: "error"; message: string };

export function RoamAiSetup({ colors, onReady, gemini }: {
  colors: Colors;
  /** Called with the GitHub user name once ROAM AI answers */
  onReady: (login: string) => void;
  /** The old Gemini key entry, offered as a fallback */
  gemini: ReactNode;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [setup, setSetup] = useState<{ stage: string; percent: number | null } | null>(null);
  const [showGemini, setShowGemini] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const un = listen<{ stage: string; percent: number | null }>("roam-ai-setup", e => setSetup(e.payload));
    return () => { alive.current = false; un.then(f => f()); };
  }, []);

  const finish = (p: Promise<string>) =>
    p.then(login => { if (alive.current) onReady(login); })
      .catch(e => {
        if (!alive.current) return;
        const msg = String(e);
        if (msg === "CANCELLED") setStep({ kind: "idle" });
        else if (msg.startsWith("NO_COPILOT:")) setStep({ kind: "no-copilot", detail: msg.slice(11).trim() });
        else setStep({ kind: "error", message: msg.replace(/^(EXPIRED|SIGN_IN|QUOTA):\s*/, "") });
      });

  const start = async () => {
    setStep({ kind: "starting" });
    try {
      const d = await invoke<{ userCode: string; verificationUri: string }>("roam_ai_sign_in_start");
      if (!alive.current) return;
      setStep({ kind: "waiting", code: d.userCode });
      await finish(invoke<string>("roam_ai_sign_in_wait").then(login => { setStep({ kind: "finishing" }); return login; }));
    } catch (e) {
      if (alive.current) setStep({ kind: "error", message: String(e) });
    }
  };
  const cancel = () => { void invoke("roam_ai_sign_in_cancel"); setStep({ kind: "idle" }); };
  const recheck = () => { setStep({ kind: "finishing" }); void finish(invoke<string>("roam_ai_check")); };
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
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
          <button type="button" onClick={start} style={primary}>Sign in to switch on ROAM AI</button>
          {installing && <span style={{ ...muted, display: "flex", alignItems: "center", gap: "6px" }}><SpinnerIcon size={12} /> Getting ROAM AI ready{setup?.percent != null ? ` ${setup.percent}%` : "..."}</span>}
        </div>
      </>)}

      {step.kind === "starting" && <div style={{ ...muted, display: "flex", alignItems: "center", gap: "6px" }}><SpinnerIcon size={12} /> Opening the sign-in window...</div>}

      {step.kind === "waiting" && (<>
        <div style={muted}>A sign-in window has opened. Your code is filled in for you:</div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span aria-label="Your one-time code" style={{ fontFamily: "Consolas, monospace", fontSize: "22px", fontWeight: "bold", letterSpacing: "3px", padding: "4px 10px", border: `1px dashed ${colors.border}`, borderRadius: "4px", userSelect: "all" }}>{step.code}</span>
          <button type="button" onClick={() => copy(step.code)} style={btn}>{copied ? "Copied" : "Copy code"}</button>
        </div>
        <ol style={{ ...muted, margin: 0, paddingLeft: "18px" }}>
          <li>Sign in to GitHub, or choose <strong>Create an account</strong> (free).</li>
          <li>Check the code matches, and press <strong>Continue</strong>.</li>
          <li>Press <strong>Authorize</strong>. The window closes and ROAM AI switches on.</li>
        </ol>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ ...muted, display: "flex", alignItems: "center", gap: "6px", marginRight: "auto" }}><SpinnerIcon size={12} /> Waiting for you to finish in the window...</span>
          <button type="button" onClick={() => invoke("roam_ai_open_sign_in", { userCode: step.code })} style={btn}>Open the window again</button>
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
          <button type="button" onClick={start} style={btn}>Use another account</button>
        </div>
        {step.detail && <div style={{ ...muted, fontSize: "11px" }}>Details: {step.detail}</div>}
      </>)}

      {step.kind === "error" && (<>
        <div role="alert" style={{ fontSize: "12px", color: "#CF222E", lineHeight: 1.45 }}>{step.message}</div>
        <div><button type="button" onClick={start} style={primary}>Try again</button></div>
      </>)}

      <div>
        <button type="button" onClick={() => setShowGemini(v => !v)} aria-expanded={showGemini}
          style={{ border: "none", background: "none", padding: 0, color: colors.text_muted, fontFamily: "inherit", fontSize: "11px", textDecoration: "underline", cursor: "pointer" }}>
          {showGemini ? "Hide the Gemini key option" : "I have a Gemini API key instead"}
        </button>
      </div>
      {showGemini && gemini}
    </div>
  );
}
