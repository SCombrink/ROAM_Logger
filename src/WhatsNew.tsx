import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SpinnerIcon } from "./icons";

// Shown once after updating to 0.7: ROAM AI moved from Gemini to GitHub
// Copilot Free. People can keep it, or go back to the previous version.

export const WHATS_NEW_KEY = "roam_whatsnew_0_7_copilot";

interface Colors { border: string; text: string; text_muted: string; primary: string; input_bg: string; modal_bg: string; modal_overlay: string; surface: string }

export function WhatsNew({ colors, onClose }: { colors: Colors; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState("");

  const revert = async () => {
    setReverting(true);
    setError("");
    try {
      await invoke("revert_to_previous_version"); // restarts the app
    } catch (e) {
      setError(String(e));
      setReverting(false);
    }
  };

  const btn = { padding: "8px 14px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "13px", fontWeight: "bold" as const, cursor: "pointer" };
  const primary = { ...btn, borderColor: colors.primary, backgroundColor: colors.primary, color: "#FFFFFF" };
  const p = { margin: "0 0 10px", fontSize: "13px", lineHeight: 1.5 };

  return (
    <div style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000, padding: "20px" }}>
      <div role="dialog" aria-modal="true" aria-label="What's new in ROAM Logger 0.7"
        style={{ width: "100%", maxWidth: "480px", backgroundColor: colors.modal_bg, color: colors.text, border: `1px solid ${colors.border}`, borderTop: "4px solid #E2231A", borderRadius: "8px", boxShadow: "0 8px 30px rgba(0,0,0,0.35)", padding: "20px 22px" }}>
        <div style={{ fontSize: "11px", fontWeight: "bold", letterSpacing: "1px", color: colors.text_muted, textTransform: "uppercase" }}>What's new in 0.7</div>
        <h2 style={{ margin: "4px 0 12px", fontSize: "19px" }}>ROAM AI now runs on GitHub Copilot Free</h2>

        {!confirming ? (<>
          <p style={p}>Gemini is now blocked, so ROAM AI (the chat and voice that fill in your observation) has moved to <strong>GitHub Copilot Free</strong>.</p>
          <ul style={{ ...p, paddingLeft: "18px" }}>
            <li><strong>Sign in once</strong> with a GitHub account. It's free, and you can create one in the sign-in window. The app fills in the code for you.</li>
            <li>It uses <strong>your own free monthly Copilot allowance</strong>. Each chat message uses a little of it.</li>
            <li><strong>Voice</strong> now uses Windows voice typing.</li>
            <li>Logging observations, drafts, the leaderboard and everything else work exactly as before, with or without ROAM AI.</li>
            <li>A Gemini key that still works can still be used as a backup.</li>
          </ul>
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap", marginTop: "14px" }}>
            <button type="button" onClick={() => setConfirming(true)} style={btn}>Go back to the previous version</button>
            <button type="button" onClick={onClose} style={primary} autoFocus>Got it</button>
          </div>
        </>) : (<>
          <p style={p}>This installs <strong>version 0.6.20</strong> (ROAM AI on Gemini) and restarts the app. Your drafts, logged observations and settings stay.</p>
          <p style={{ ...p, color: colors.text_muted }}>Gemini is blocked on the company network, so ROAM AI may not answer in that version. The update to 0.7 will be offered again from the ⓘ menu whenever you want it.</p>
          {error && <div role="alert" style={{ ...p, color: "#CF222E" }}>{error}</div>}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap", marginTop: "14px" }}>
            {reverting && <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: colors.text_muted, marginRight: "auto" }}><SpinnerIcon size={13} /> Installing 0.6.20...</span>}
            <button type="button" onClick={() => setConfirming(false)} disabled={reverting} style={btn}>Back</button>
            <button type="button" onClick={revert} disabled={reverting} style={{ ...primary, cursor: reverting ? "wait" : "pointer" }}>Install 0.6.20 and restart</button>
          </div>
        </>)}
      </div>
    </div>
  );
}
