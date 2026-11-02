import { useState } from "react";
import { CloseIcon } from "./icons";

// Observations that did not reach ROAM, kept on this computer so they are
// never lost. Each can be loaded back into the form and submitted again;
// it leaves the outbox once ROAM confirms it.

export interface OutboxForm {
  project: string; office: string; address: string; exactLoc: string;
  /** As the date field holds it, "YYYY-MM-DD" */
  date: string; time: string;
  isContractor: boolean; isWorkHours: boolean;
  obsType: string; obsSafe: string; officeLoc: string;
  details: string; action: string; category: string; cardType: string;
}

export interface OutboxEntry {
  id: string;
  /** When it was last put in the outbox (ISO) */
  savedAt: string;
  /** Why it is here: the error's first line, or "Saved for later" */
  reason: string;
  /** Submit was clicked but ROAM never confirmed: it may already be saved */
  maybeSaved: boolean;
  form: OutboxForm;
}

const KEY = "roam_outbox";

export function loadOutbox(): OutboxEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

export function storeOutbox(entries: OutboxEntry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* storage unavailable */ }
}

const sameForm = (a: OutboxForm, b: OutboxForm) => JSON.stringify(a) === JSON.stringify(b);

/** Adds an observation, or updates it if it is already there (the one
 *  loaded from the outbox, or one with exactly the same content). */
export function putInOutbox(entries: OutboxEntry[], form: OutboxForm, reason: string, maybeSaved: boolean, loadedId: string | null): { entries: OutboxEntry[]; id: string } {
  const existing = entries.find(e => e.id === loadedId) ?? entries.find(e => sameForm(e.form, form));
  const entry: OutboxEntry = { id: existing?.id ?? `${Date.now()}`, savedAt: new Date().toISOString(), reason, maybeSaved, form };
  return { entries: existing ? entries.map(e => (e.id === existing.id ? entry : e)) : [...entries, entry], id: entry.id };
}

/** "Could not reach ROAM ... \n\nMost likely..." -> its first line, shortened. */
export function shortReason(error: string): string {
  const first = error.split("\n").map(l => l.trim()).find(Boolean) ?? "Not submitted";
  return first.length > 140 ? `${first.slice(0, 140)}...` : first;
}

function when(form: OutboxForm): string {
  const d = form.date ? new Date(`${form.date}T00:00`) : null;
  const day = d && !isNaN(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "No date";
  return form.time ? `${day} ${form.time}` : day;
}

interface Colors { border: string; text: string; text_muted: string; primary: string; input_bg: string; surface: string; card_bg: string; warning: string; error_red: string }

export function OutboxPanel({ colors, entries, loadedId, formJson, formHasText, canSaveForLater, onSaveForLater, onLoad, onDelete }: {
  colors: Colors;
  entries: OutboxEntry[];
  /** The entry currently loaded in the form */
  loadedId: string | null;
  /** The form's current content, to show which entry it holds */
  formJson: string;
  /** The form holds typed text that loading would replace */
  formHasText: boolean;
  canSaveForLater: boolean;
  onSaveForLater: () => void;
  onLoad: (entry: OutboxEntry) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [confirm, setConfirm] = useState<{ id: string; what: "load" | "delete" } | null>(null);
  if (entries.length === 0 && !canSaveForLater) return null;

  const small = { height: "24px", boxSizing: "border-box" as const, padding: "0 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "11px", fontWeight: "bold" as const, cursor: "pointer", flexShrink: 0 };
  return (
    <div aria-label="Outbox" style={{ border: `1px solid ${entries.length ? colors.warning : colors.border}`, borderRadius: "8px", overflow: "hidden", backgroundColor: colors.card_bg }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", backgroundColor: colors.surface, borderBottom: open && entries.length ? `1px solid ${colors.border}` : "none" }}>
        <button type="button" onClick={() => setOpen(o => !o)} disabled={!entries.length} aria-expanded={open}
          style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "none", padding: 0, fontFamily: "inherit", fontSize: "13px", fontWeight: "bold", color: colors.text, cursor: entries.length ? "pointer" : "default" }}>
          Outbox {entries.length > 0 && <span style={{ color: colors.warning }}>· {entries.length} not submitted yet</span>}
        </button>
        {canSaveForLater && (
          <button type="button" onClick={onSaveForLater} title="Keep this observation here and submit it later, e.g. when ROAM is down" style={small}>Save for later</button>
        )}
      </div>
      {open && entries.map(e => {
        const loaded = e.id === loadedId || JSON.stringify(e.form) === formJson;
        const asking = confirm?.id === e.id ? confirm.what : null;
        return (
          <div key={e.id} style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "6px 10px", borderBottom: `1px solid ${colors.border}`, fontSize: "13px" }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
              <div style={{ fontWeight: "bold" }}>
                {when(e.form)} · {e.form.cardType}{e.form.category ? ` · ${e.form.category}` : ""}{loaded && <span style={{ fontWeight: "normal", color: colors.primary }}> · in the form now</span>}
              </div>
              <div style={{ color: colors.text_muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.form.details || "(no details)"}</div>
              <div style={{ fontSize: "11px", color: e.maybeSaved ? colors.warning : colors.text_muted }}>
                {e.maybeSaved ? "May already be in ROAM: check there before submitting it again." : e.reason}
              </div>
            </div>
            {asking === "load" ? (
              <button type="button" onClick={() => { setConfirm(null); onLoad(e); }} style={{ ...small, borderColor: colors.primary, backgroundColor: colors.primary, color: "#FFFFFF" }}>Replace the form?</button>
            ) : (
              <button type="button" disabled={loaded} onClick={() => (formHasText && !loaded ? setConfirm({ id: e.id, what: "load" }) : onLoad(e))}
                title="Put this observation back in the form to submit it" style={{ ...small, opacity: loaded ? 0.5 : 1, cursor: loaded ? "default" : "pointer" }}>Load</button>
            )}
            {asking === "delete" ? (
              <button type="button" onClick={() => { setConfirm(null); onDelete(e.id); }} style={{ ...small, borderColor: colors.error_red, backgroundColor: colors.error_red, color: "#FFFFFF" }}>Delete?</button>
            ) : (
              <button type="button" onClick={() => setConfirm({ id: e.id, what: "delete" })} aria-label="Delete from the outbox" title="Delete from the outbox" className="icon-btn"
                style={{ ...small, width: "24px", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", color: colors.text_muted }}><CloseIcon size={11} /></button>
            )}
          </div>
        );
      })}
    </div>
  );
}
