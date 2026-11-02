import { useEffect, useRef, useState } from "react";
import { CloseIcon, PlusIcon, SpinnerIcon } from "./icons";

// Send feedback: a short description and any screenshots or files. Saved on
// this computer and written to the feedback folder in SharePoint (sent later
// if SharePoint can't be reached). ROAM AI summarises the text for the app
// owner; attachments are never sent to the AI.

interface Colors { border: string; text: string; text_muted: string; primary: string; input_bg: string; surface: string; modal_bg: string; modal_overlay: string }

export interface FeedbackFile { name: string; data: string; size: number; preview?: string }

const MAX_FILES = 6;
const MAX_BYTES = 10 * 1024 * 1024;

function readFile(file: File): Promise<FeedbackFile> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ name: file.name || "screenshot.png", data: url.slice(url.indexOf(",") + 1), size: file.size, preview: file.type.startsWith("image/") ? url : undefined });
    };
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

export function FeedbackModal({ colors, onSend, onClose }: {
  colors: Colors;
  /** Resolves to "sent" or "queued" */
  onSend: (message: string, files: FeedbackFile[], includeResults: boolean) => Promise<string>;
  onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<FeedbackFile[]>([]);
  const [includeResults, setIncludeResults] = useState(true);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !sending) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  const add = async (list: File[]) => {
    setError("");
    const room = MAX_FILES - files.length;
    if (list.length > room) setError(`Up to ${MAX_FILES} files.`);
    const tooBig = list.filter(f => f.size > MAX_BYTES);
    if (tooBig.length) setError(`${tooBig.map(f => f.name).join(", ")}: larger than 10 MB.`);
    const ok = list.filter(f => f.size <= MAX_BYTES).slice(0, Math.max(0, room));
    try {
      const read = await Promise.all(ok.map(readFile));
      setFiles(prev => [...prev, ...read]);
    } catch (e) {
      setError(`${e}`);
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const pasted = [...e.clipboardData.items].filter(i => i.kind === "file").map(i => i.getAsFile()).filter((f): f is File => !!f);
    if (pasted.length) {
      e.preventDefault();
      add(pasted.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `screenshot-${files.length + i + 1}.png`, { type: f.type }))));
    }
  };
  const send = async () => {
    setSending(true);
    setError("");
    try {
      await onSend(message, files, includeResults);
    } catch (e) {
      setError(`${e}`);
      setSending(false);
    }
  };

  const btn = { padding: "6px 12px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "11px", fontWeight: "bold" as const, cursor: "pointer" };
  const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget && !sending) onClose(); }} style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div role="dialog" aria-label="Send feedback"
        onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); add([...e.dataTransfer.files]); }}
        style={{ width: "100%", maxWidth: "440px", backgroundColor: colors.modal_bg, color: colors.text, border: `1px solid ${dragging ? colors.primary : colors.border}`, borderRadius: "8px", boxShadow: "0 4px 20px rgba(0,0,0,0.3)", overflow: "hidden" }}>
        <div style={{ padding: "6px 6px 6px 12px", minHeight: "36px", boxSizing: "border-box", display: "flex", alignItems: "center", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "13px" }}>
          <span style={{ flex: 1 }}>Send feedback</span>
          <button type="button" onClick={onClose} disabled={sending} aria-label="Close" title="Close" className="icon-btn" style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "4px", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><CloseIcon /></button>
        </div>
        <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <textarea value={message} onChange={e => setMessage(e.target.value)} onPaste={onPaste} rows={5} maxLength={5000} autoFocus aria-label="Describe the issue"
            placeholder="Describe the issue or idea in a few words. You can paste a screenshot here (Ctrl+V)."
            style={{ width: "100%", boxSizing: "border-box", padding: "8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "13px", resize: "vertical", userSelect: "text" }} />

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }} aria-label="Attachments">
            {files.map((f, i) => (
              <div key={i} title={`${f.name} (${kb(f.size)})`} style={{ position: "relative", width: "64px", height: "64px", border: `1px solid ${colors.border}`, borderRadius: "4px", overflow: "hidden", backgroundColor: colors.surface, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {f.preview ? <img src={f.preview} alt={f.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <span style={{ fontSize: "10px", padding: "4px", textAlign: "center", wordBreak: "break-all", color: colors.text_muted }}>{f.name}</span>}
                <button type="button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}
                  style={{ position: "absolute", top: "2px", right: "2px", width: "18px", height: "18px", padding: 0, border: "none", borderRadius: "50%", backgroundColor: "rgba(0,0,0,0.6)", color: "#FFFFFF", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><CloseIcon size={10} /></button>
              </div>
            ))}
            {files.length < MAX_FILES && (
              <button type="button" onClick={() => picker.current?.click()} title="Add screenshots or files (or drag them here)"
                style={{ width: "64px", height: "64px", border: `1px dashed ${colors.border}`, borderRadius: "4px", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px", fontFamily: "inherit", fontSize: "10px" }}>
                <PlusIcon size={14} /> Add files
              </button>
            )}
            <input ref={picker} type="file" multiple hidden onChange={e => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
          </div>

          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px", cursor: "pointer" }}>
            <input type="checkbox" checked={includeResults} onChange={e => setIncludeResults(e.target.checked)} />
            Include my recent logging results (never what I wrote)
          </label>
          <div style={{ fontSize: "11px", color: colors.text_muted, lineHeight: 1.4 }}>Your name and app version are included so we can follow up. ROAM AI summarises your description for the developer; images and files are never sent to AI.</div>
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
