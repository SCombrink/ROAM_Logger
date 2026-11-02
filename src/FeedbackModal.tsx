import { useEffect, useState } from "react";
import { CloseIcon, SpinnerIcon } from "./icons";

// Send feedback to the app owner: saved on this computer and written to the
// feedback folder in SharePoint (sent later if SharePoint can't be reached).

interface Colors { border: string; text: string; text_muted: string; primary: string; input_bg: string; surface: string; modal_bg: string; modal_overlay: string }

const KINDS = ["Problem", "Idea", "Question", "Other"];

export function FeedbackModal({ colors, onSend, onClose }: {
  colors: Colors;
  /** Resolves to "sent" or "queued" */
  onSend: (kind: string, message: string, includeResults: boolean) => Promise<string>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState("Problem");
  const [message, setMessage] = useState("");
  const [includeResults, setIncludeResults] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !sending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  const send = async () => {
    setSending(true);
    setError("");
    try {
      await onSend(kind, message, includeResults);
    } catch (e) {
      setError(`${e}`);
      setSending(false);
    }
  };

  const btn = { padding: "6px 12px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "11px", fontWeight: "bold" as const, cursor: "pointer" };
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget && !sending) onClose(); }} style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div role="dialog" aria-label="Send feedback" style={{ width: "100%", maxWidth: "440px", backgroundColor: colors.modal_bg, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: "8px", boxShadow: "0 4px 20px rgba(0,0,0,0.3)", overflow: "hidden" }}>
        <div style={{ padding: "6px 6px 6px 12px", minHeight: "36px", boxSizing: "border-box", display: "flex", alignItems: "center", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "13px" }}>
          <span style={{ flex: 1 }}>Send feedback</span>
          <button type="button" onClick={onClose} disabled={sending} aria-label="Close" title="Close" className="icon-btn" style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "4px", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><CloseIcon /></button>
        </div>
        <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", gap: "4px" }} role="radiogroup" aria-label="Kind of feedback">
            {KINDS.map(k => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                style={{ ...btn, flex: 1, borderColor: kind === k ? colors.primary : colors.border, backgroundColor: kind === k ? colors.primary : colors.input_bg, color: kind === k ? "#FFFFFF" : colors.text }}>{k}</button>
            ))}
          </div>
          <textarea value={message} onChange={e => setMessage(e.target.value)} rows={6} maxLength={5000} autoFocus aria-label="Your feedback"
            placeholder={kind === "Problem" ? "What happened, and what did you expect? e.g. \"Logging failed twice this morning with a sign-in message.\"" : kind === "Idea" ? "What would make the app better for you?" : "Write your message..."}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "13px", resize: "vertical", userSelect: "text" }} />
          <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12px", color: colors.text, cursor: "pointer" }}>
            <input type="checkbox" checked={includeResults} onChange={e => setIncludeResults(e.target.checked)} style={{ marginTop: "2px" }} />
            <span>Include my last 10 logging results (times, outcome, errors and card type; never what I wrote), to help find problems.</span>
          </label>
          <div style={{ fontSize: "11px", color: colors.text_muted }}>Your name, email, computer name and app version are included so we can follow up.</div>
          {error && <div role="alert" style={{ fontSize: "13px", color: "#CF222E" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px", alignItems: "center" }}>
            {sending && <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: colors.text_muted, marginRight: "auto" }}><SpinnerIcon size={13} /> Sending...</span>}
            <button type="button" onClick={onClose} disabled={sending} style={btn}>Cancel</button>
            <button type="button" onClick={send} disabled={sending || !message.trim()}
              style={{ ...btn, borderColor: colors.primary, backgroundColor: colors.primary, color: "#FFFFFF", opacity: message.trim() ? 1 : 0.6, cursor: sending ? "wait" : message.trim() ? "pointer" : "not-allowed" }}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}
