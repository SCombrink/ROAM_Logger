import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircleIcon, ChevronIcon, CloseIcon, OutboxIcon } from "./icons";

// The right-hand sidebar, like a mail client's folders:
// - Outbox: observations that did not reach ROAM, kept on this computer so
//   they are never lost, until they are sent again (or deleted).
// - Sent: the observations ROAM confirmed, as they were submitted.
// Both live in this app on this computer only. Any of them opens a
// read-only view of the form.

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

export interface SentEntry {
  id: string;
  /** When ROAM confirmed it (ISO) */
  sentAt: string;
  form: OutboxForm;
}

const KEY = "roam_outbox";
/** Below this window width the sidebar shows as a strip. */
const NARROW = 960;
const SENT_KEY = "roam_sent";
/** How many sent observations are kept. */
const SENT_LIMIT = 300;

export function loadOutbox(): OutboxEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

export function storeOutbox(entries: OutboxEntry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* storage unavailable */ }
}

export function loadSent(): SentEntry[] {
  try { return JSON.parse(localStorage.getItem(SENT_KEY) || "[]"); } catch { return []; }
}

/** Adds a confirmed observation to Sent (newest first). */
export function addSent(entries: SentEntry[], form: OutboxForm): SentEntry[] {
  const next = [{ id: `${Date.now()}`, sentAt: new Date().toISOString(), form }, ...entries].slice(0, SENT_LIMIT);
  try { localStorage.setItem(SENT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
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

function obsWhen(form: OutboxForm): string {
  const d = form.date ? new Date(`${form.date}T00:00`) : null;
  const day = d && !isNaN(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "No date";
  return form.time ? `${day} ${form.time}` : day;
}

function stamp(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

export interface MailColors { border: string; text: string; text_muted: string; primary: string; input_bg: string; surface: string; card_bg: string; warning: string; error_red: string; success: string; modal_bg: string; modal_overlay: string }

type Folder = "outbox" | "sent";
type Opened = { kind: "outbox"; entry: OutboxEntry } | { kind: "sent"; entry: SentEntry };

export function MailSidebar({ colors, outbox, sent, loadedId, formJson, formHasText, canSaveForLater, canSend, onSaveForLater, onSendAgain, onLoad, onDelete, onWidth }: {
  colors: MailColors;
  /** Reports the sidebar's width, so notifications can sit beside it */
  onWidth?: (px: number) => void;
  outbox: OutboxEntry[];
  sent: SentEntry[];
  /** The outbox entry currently loaded in the form */
  loadedId: string | null;
  /** The form's current content, to show which entry it holds */
  formJson: string;
  /** The form holds typed text that loading would replace */
  formHasText: boolean;
  canSaveForLater: boolean;
  /** Connected to ROAM and not already submitting */
  canSend: boolean;
  onSaveForLater: () => void;
  /** Loads the entry into the form and submits it */
  onSendAgain: (entry: OutboxEntry) => void;
  onLoad: (entry: OutboxEntry) => void;
  onDelete: (id: string) => void;
}) {
  const [folder, setFolder] = useState<Folder>(() => (loadOutbox().length ? "outbox" : "sent"));
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("roam_mail_collapsed") === "1"; } catch { return false; } });
  const [opened, setOpened] = useState<Opened | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; what: "replace-send" | "replace-load" | "delete" } | null>(null);
  // Something new in the outbox: show it.
  const [seenCount, setSeenCount] = useState(outbox.length);
  useEffect(() => {
    if (outbox.length > seenCount) setFolder("outbox");
    setSeenCount(outbox.length);
  }, [outbox.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Something just sent, and nothing left waiting: show it in Sent.
  const [sentCount, setSentCount] = useState(sent.length);
  useEffect(() => {
    if (sent.length > sentCount && outbox.length === 0) setFolder("sent");
    setSentCount(sent.length);
  }, [sent.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // In a narrow window the sidebar folds to a strip, so the form keeps its room.
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => { onWidth?.(collapsed || narrow ? 30 : 244); }, [collapsed, narrow]); // eslint-disable-line react-hooks/exhaustive-deps
  const collapse = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem("roam_mail_collapsed", v ? "1" : "0"); } catch { /* storage unavailable */ }
  };

  const panel = { border: `1px solid ${colors.border}`, borderRadius: "8px", backgroundColor: colors.card_bg, overflow: "hidden" as const, position: "sticky" as const, top: "16px", flexShrink: 0, height: "calc(100vh - 32px)", boxSizing: "border-box" as const, display: "flex", flexDirection: "column" as const };
  const chevronBtn = { width: "20px", height: "20px", padding: 0, border: "none", borderRadius: "4px", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
  const small = { height: "24px", boxSizing: "border-box" as const, padding: "0 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "11px", fontWeight: "bold" as const, cursor: "pointer", flexShrink: 0 };
  const primary = { ...small, borderColor: colors.warning, backgroundColor: colors.warning, color: "#FFFFFF" };

  if (collapsed || narrow) {
    return (
      <div style={{ ...panel, width: "30px", alignItems: "center" }}>
        <div style={{ width: "100%", minHeight: "36px", boxSizing: "border-box", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <button onClick={() => collapse(false)} disabled={narrow} title={narrow ? "Make the window wider to see your outbox and logged observations" : "Show outbox and logged observations"} aria-label="Show outbox and logged observations" className="icon-btn" style={chevronBtn}><ChevronIcon dir="right" size={14} /></button>
        </div>
        {outbox.length > 0 && (
          <button onClick={() => { collapse(false); setFolder("outbox"); }} title={narrow ? `${outbox.length} not logged yet: make the window wider to see them` : `${outbox.length} not logged yet`} aria-label={`Outbox: ${outbox.length} not logged yet`}
            style={{ marginTop: "8px", minWidth: "20px", height: "20px", padding: "0 4px", borderRadius: "10px", border: "none", backgroundColor: colors.warning, color: "#FFFFFF", fontSize: "11px", fontWeight: "bold", cursor: "pointer" }}>{outbox.length}</button>
        )}
      </div>
    );
  }

  const folderBtn = (f: Folder, label: string, count: number, icon: React.ReactNode, attention: boolean) => (
    <button
      type="button"
      onClick={() => setFolder(f)}
      aria-pressed={folder === f}
      style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: "5px", height: "28px", padding: "0 6px", border: `1px solid ${folder === f ? colors.primary : colors.border}`, borderRadius: "4px", backgroundColor: folder === f ? colors.primary : colors.input_bg, color: folder === f ? "#FFFFFF" : colors.text, fontFamily: "inherit", fontSize: "11px", fontWeight: "bold", cursor: "pointer" }}
    >
      {icon} {label}
      {count > 0 && <span style={{ minWidth: "16px", padding: "0 4px", boxSizing: "border-box", borderRadius: "8px", fontSize: "10px", lineHeight: "16px", backgroundColor: attention ? colors.warning : folder === f ? "rgba(255,255,255,0.25)" : colors.surface, color: attention || folder === f ? "#FFFFFF" : colors.text_muted }}>{count}</span>}
    </button>
  );

  // Loading or sending replaces what is in the form: ask first if it holds other text.
  const guarded = (e: OutboxEntry, what: "replace-send" | "replace-load", run: () => void) => {
    const inForm = e.id === loadedId || JSON.stringify(e.form) === formJson;
    if (formHasText && !inForm && confirm?.id !== e.id) { setConfirm({ id: e.id, what }); return; }
    setConfirm(null);
    run();
  };

  const outboxCard = (e: OutboxEntry) => {
    const inForm = e.id === loadedId || JSON.stringify(e.form) === formJson;
    const asking = confirm?.id === e.id ? confirm.what : null;
    return (
      <div key={e.id} style={{ border: `1px solid ${colors.border}`, borderLeft: `4px solid ${colors.warning}`, borderRadius: "4px", backgroundColor: colors.input_bg, display: "flex", flexDirection: "column" }}>
        <button type="button" onClick={() => setOpened({ kind: "outbox", entry: e })} title="View this observation" className="icon-btn"
          style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "6px 8px 4px", border: "none", background: "none", textAlign: "left", fontFamily: "inherit", color: colors.text, cursor: "pointer" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%" }}>
            <b style={{ flex: 1, fontSize: "12px" }}>{obsWhen(e.form)} · {e.form.cardType}</b>
            <span style={{ fontSize: "10px", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.3px", color: colors.warning }}>{e.maybeSaved ? "Check" : "Not logged"}</span>
          </span>
          <span style={{ fontSize: "12px", color: colors.text, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{e.form.details || "(no details)"}</span>
          <span style={{ fontSize: "11px", color: e.maybeSaved ? colors.warning : colors.text_muted }}>
            {e.maybeSaved ? "May already be in ROAM: check there before logging it again." : e.reason}
          </span>
          {inForm && <span style={{ fontSize: "11px", color: colors.primary }}>In the form now</span>}
        </button>
        <div style={{ display: "flex", gap: "4px", padding: "0 8px 6px" }}>
          {asking === "replace-send" || asking === "replace-load" ? (
            <button type="button" onClick={() => guarded(e, asking, () => (asking === "replace-send" ? onSendAgain(e) : onLoad(e)))} style={{ ...primary, flex: 1 }}>Replace the form?</button>
          ) : e.maybeSaved || !canSend ? (
            <button type="button" onClick={() => guarded(e, "replace-load", () => onLoad(e))} title={canSend ? "Put it back in the form to check and log it" : "Put it back in the form; connect to ROAM to log it"} style={{ ...primary, flex: 1 }}>Load into form</button>
          ) : (
            <button type="button" onClick={() => guarded(e, "replace-send", () => onSendAgain(e))} title="Put it back in the form and log it now" style={{ ...primary, flex: 1 }}>Log again</button>
          )}
          {asking === "delete" ? (
            <button type="button" onClick={() => { setConfirm(null); onDelete(e.id); }} style={{ ...small, borderColor: colors.error_red, backgroundColor: colors.error_red, color: "#FFFFFF" }}>Delete?</button>
          ) : (
            <button type="button" onClick={() => setConfirm({ id: e.id, what: "delete" })} aria-label="Delete from the outbox" title="Delete from the outbox" className="icon-btn"
              style={{ ...small, width: "24px", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", color: colors.text_muted }}><CloseIcon size={11} /></button>
          )}
        </div>
      </div>
    );
  };

  const sentRow = (e: SentEntry) => (
    <button key={e.id} type="button" onClick={() => setOpened({ kind: "sent", entry: e })} title="View what was logged" className="icon-btn"
      style={{ display: "flex", gap: "6px", alignItems: "flex-start", padding: "6px 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, textAlign: "left", fontFamily: "inherit", color: colors.text, cursor: "pointer" }}>
      <span style={{ color: colors.success, display: "flex", paddingTop: "1px" }}><CheckCircleIcon size={13} /></span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1px" }}>
        <b style={{ fontSize: "12px" }}>{obsWhen(e.form)} · {e.form.cardType}</b>
        <span style={{ fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.form.details || "(no details)"}</span>
        <span style={{ fontSize: "11px", color: colors.text_muted }}>Logged {stamp(e.sentAt)}</span>
      </span>
    </button>
  );

  return (
    <div style={{ ...panel, width: "244px" }} aria-label="Outbox and logged observations">
      <div style={{ minHeight: "36px", boxSizing: "border-box", padding: "6px 6px 6px 10px", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: "6px" }}>
        <b style={{ flex: 1, fontSize: "13px" }}>My observations</b>
        <button onClick={() => collapse(true)} title="Hide" aria-label="Hide outbox and logged observations" className="icon-btn" style={chevronBtn}><ChevronIcon dir="left" size={14} /></button>
      </div>
      <div style={{ display: "flex", gap: "4px", padding: "6px 8px", borderBottom: `1px solid ${colors.border}` }}>
        {folderBtn("outbox", "Outbox", outbox.length, <OutboxIcon size={12} />, outbox.length > 0 && folder !== "outbox")}
        {folderBtn("sent", "Logged", sent.length, <CheckCircleIcon size={12} />, false)}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 8px", display: "flex", flexDirection: "column", gap: "6px" }}>
        {folder === "outbox" ? <>
          {canSaveForLater && (
            <button type="button" onClick={onSaveForLater} title="Keep the observation in the form here, to log later (e.g. when ROAM is down)" style={{ ...small, alignSelf: "stretch" }}>Save the form for later</button>
          )}
          {outbox.length === 0
            ? <div style={{ padding: "8px 2px", fontSize: "12px", color: colors.text_muted, lineHeight: 1.4 }}>Nothing waiting. If an observation doesn't go through, it's kept here so it's never lost, and you can log it again.</div>
            : outbox.map(outboxCard)}
        </> : (
          sent.length === 0
            ? <div style={{ padding: "8px 2px", fontSize: "12px", color: colors.text_muted, lineHeight: 1.4 }}>Observations you log from this computer appear here, so you can see what you logged and when.</div>
            : sent.map(sentRow)
        )}
      </div>
      {/* At page level: the sidebar is sticky, which would keep the view
          underneath the form column. */}
      {opened && createPortal(
        <ObservationView
          colors={colors}
          opened={opened}
          canSend={canSend}
          onClose={() => setOpened(null)}
          onSendAgain={e => { setOpened(null); guarded(e, "replace-send", () => onSendAgain(e)); }}
          onLoad={e => { setOpened(null); guarded(e, "replace-load", () => onLoad(e)); }}
        />,
        document.body,
      )}
    </div>
  );
}

/** A read-only view of the form as it was submitted (or is waiting). */
function ObservationView({ colors, opened, canSend, onClose, onSendAgain, onLoad }: {
  colors: MailColors;
  opened: Opened;
  canSend: boolean;
  onClose: () => void;
  onSendAgain: (e: OutboxEntry) => void;
  onLoad: (e: OutboxEntry) => void;
}) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const f = opened.entry.form;
  const section = (title: string, rows: [string, string][]) => (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: "6px", overflow: "hidden" }}>
      <div style={{ padding: "5px 10px", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "12px" }}>{title}</div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "flex", gap: "10px", padding: "5px 10px", borderBottom: `1px solid ${colors.border}`, fontSize: "13px" }}>
          <span style={{ width: "110px", flexShrink: 0, fontSize: "11px", fontWeight: "bold", letterSpacing: "0.3px", color: colors.text_muted, textTransform: "uppercase", paddingTop: "1px" }}>{label}</span>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" }}>{value || "-"}</span>
        </div>
      ))}
    </div>
  );
  const btn = { padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, fontWeight: "bold" as const, color: colors.text, fontSize: "11px", cursor: "pointer", fontFamily: "inherit" };
  const isSent = opened.kind === "sent";
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div role="dialog" aria-label={isSent ? "Logged observation" : "Observation not logged yet"} style={{ backgroundColor: colors.modal_bg, color: colors.text, borderRadius: "8px", width: "100%", maxWidth: "520px", maxHeight: "86vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.3)", border: `1px solid ${colors.border}` }}>
        <div style={{ padding: "6px 6px 6px 10px", minHeight: "36px", boxSizing: "border-box", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ display: "flex", color: isSent ? colors.success : colors.warning }}>{isSent ? <CheckCircleIcon size={15} /> : <OutboxIcon size={15} />}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: "13px" }}>
            <b>{isSent ? "Logged" : opened.entry.maybeSaved ? "Not confirmed" : "Not logged yet"}</b>
            <span style={{ color: colors.text_muted }}> · {isSent ? stamp(opened.entry.sentAt) : `kept ${stamp(opened.entry.savedAt)}`}</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close" title="Close" className="icon-btn" style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "4px", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><CloseIcon /></button>
        </div>
        <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "8px", overflowY: "auto" }}>
          {!isSent && (
            <div style={{ fontSize: "13px", padding: "6px 8px", borderRadius: "4px", borderLeft: `4px solid ${colors.warning}`, backgroundColor: colors.surface }}>
              {opened.entry.maybeSaved ? "ROAM didn't confirm this one, so it may already be saved. Check ROAM before logging it again." : `Why it wasn't logged: ${opened.entry.reason}`}
            </div>
          )}
          {section("Where and when", [["Project", f.project], ["Office", f.office], ["Address", f.address], ["Location", f.exactLoc], ["Date", f.date ? new Date(`${f.date}T00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : ""], ["Time", f.time]])}
          {section("What happened", [
            ["Contractor", f.isContractor ? "Yes" : "No"], ["Working hours", f.isWorkHours ? "Yes" : "No"],
            ["Type", f.obsType], ["Safe / at risk", f.obsSafe], ["Where", f.officeLoc],
            ["Details", f.details], ["Immediate action", f.action],
          ])}
          {section("Classification", [["Category", f.category], ["Card type", f.cardType]])}
        </div>
        <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end", padding: "8px 10px", borderTop: `1px solid ${colors.border}` }}>
          {opened.kind === "outbox" && <>
            <button type="button" onClick={() => onLoad(opened.entry)} style={btn}>Load into form</button>
            {!opened.entry.maybeSaved && canSend && (
              <button type="button" onClick={() => onSendAgain(opened.entry)} style={{ ...btn, borderColor: colors.warning, backgroundColor: colors.warning, color: "#FFFFFF" }}>Log again</button>
            )}
          </>}
          <button type="button" onClick={onClose} style={{ ...btn, ...(isSent ? { backgroundColor: colors.primary, borderColor: colors.primary, color: "#FFFFFF" } : {}) }}>Close</button>
        </div>
      </div>
    </div>
  );
}
