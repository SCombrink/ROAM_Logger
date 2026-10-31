import { useState } from "react";
import { CheckIcon, CloseIcon, CopyIcon, DownloadIcon, SpinnerIcon, UsersIcon } from "./icons";
import type { SidebarColors } from "./MonthlySidebar";
import { displayName } from "./observationStats";

export interface PasteResult {
  observers: Record<string, Record<string, number>>;
  matches: { input: string; name: string }[];
  unmatched: string[];
  /** Work email per report name, where known */
  emails?: Record<string, string>;
  fetchedAt: string;
}

interface CrewModalProps {
  colors: SidebarColors & { modal_bg: string; modal_overlay: string };
  crew: string[];
  /** Progress text while searching ("Searching 2 of 4...") */
  progress: string;
  onRemove: (name: string) => void;
  /** Finds the people in pasted lines */
  onMatch: (lines: string[]) => Promise<PasteResult>;
  /** Adds the chosen people, with the data already read for them */
  onAdd: (names: string[], result: PasteResult) => void;
  /** Copies the crew's names to share; exports the year to Excel */
  onCopy: () => void;
  onExport: () => void;
  onClose: () => void;
}

/** "My crew": the colleagues you compare yourself with, and pasting a list to add many at once. */
export function CrewModal({ colors, crew, progress, onRemove, onMatch, onAdd, onCopy, onExport, onClose }: CrewModalProps) {
  const [text, setText] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PasteResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const inCrew = (name: string) => crew.some(c => c.toLowerCase() === name.toLowerCase());
  const lineCount = text.split(/\r?\n/).filter(l => l.trim()).length;

  const find = async () => {
    setSearching(true);
    setError("");
    setResult(null);
    try {
      const r = await onMatch(text.split(/\r?\n/));
      setResult(r);
      setChosen(new Set(r.matches.map(m => m.name).filter(n => !inCrew(n))));
    } catch (e) {
      setError(`${e}`);
    } finally {
      setSearching(false);
    }
  };

  const toggle = (name: string) => setChosen(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const btn = { padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, fontWeight: "bold" as const, color: colors.text, fontSize: "11px", cursor: "pointer", fontFamily: "inherit" };
  const primaryBtn = { ...btn, backgroundColor: colors.primary, borderColor: colors.primary, color: "#FFFFFF" };
  const sectionTitle = { fontSize: "11px", fontWeight: "bold" as const, letterSpacing: "0.3px", color: colors.text };
  const uniqueMatches = result ? result.matches.filter((m, i, all) => all.findIndex(x => x.name === m.name) === i) : [];

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div role="dialog" aria-label="My crew" style={{ backgroundColor: colors.modal_bg, color: colors.text, borderRadius: "8px", width: "100%", maxWidth: "460px", maxHeight: "86vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.3)", border: `1px solid ${colors.border}` }}>
        <div style={{ padding: "6px 6px 6px 10px", minHeight: "36px", boxSizing: "border-box", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}>
          <UsersIcon size={15} /> <span style={{ flex: 1 }}>My crew</span>
          <button type="button" onClick={onClose} aria-label="Close" title="Close" className="icon-btn" style={{ width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "4px", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><CloseIcon /></button>
        </div>

        <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "10px", overflowY: "auto", minHeight: 0 }}>
          <div style={{ fontSize: "13px", color: colors.text_muted, lineHeight: 1.4 }}>
            Your crew are the colleagues you compete with. Add them with the <b>+</b> next to a name in "Look up a colleague", or paste a list below.
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <span style={{ ...sectionTitle, flex: 1 }}>IN YOUR CREW ({crew.length})</span>
            {crew.length > 0 && <>
              <button type="button" onClick={onCopy} title="Copy the names to share with others" style={{ ...btn, padding: "3px 8px", display: "flex", alignItems: "center", gap: "4px" }}><CopyIcon size={12} /> Share list</button>
              <button type="button" onClick={onExport} title="Export this year's counts to Excel" style={{ ...btn, padding: "3px 8px", display: "flex", alignItems: "center", gap: "4px" }}><DownloadIcon size={12} /> Export to Excel</button>
            </>}
          </div>
          {crew.length === 0 ? (
            <div style={{ fontSize: "13px", color: colors.text_muted }}>No one yet.</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {crew.map(name => (
                <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: "2px", padding: "2px 2px 2px 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", fontSize: "12px", backgroundColor: colors.input_bg }}>
                  {displayName(name)}
                  <button type="button" onClick={() => onRemove(name)} aria-label={`Remove ${displayName(name)}`} title="Remove from crew" className="icon-btn" style={{ width: "18px", height: "18px", padding: 0, border: "none", borderRadius: "3px", background: "none", color: colors.text_muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><CloseIcon size={11} /></button>
                </span>
              ))}
            </div>
          )}

          <div style={sectionTitle}>ADD FROM A LIST</div>
          <textarea
            id="crew-paste"
            value={text}
            onChange={e => { setText(e.target.value); setResult(null); setError(""); }}
            placeholder={"Paste names from Excel, one per line:\nJack Abbas\nAbbott, Ryan\nsipho.mokoena@hatch.com"}
            rows={5}
            style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontFamily: "inherit", fontSize: "13px", resize: "vertical", userSelect: "text" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button type="button" onClick={find} disabled={searching || lineCount === 0} style={{ ...btn, cursor: searching ? "wait" : lineCount === 0 ? "not-allowed" : "pointer", opacity: lineCount === 0 ? 0.6 : 1 }}>
              Find {lineCount > 0 ? `${lineCount} ${lineCount === 1 ? "name" : "names"}` : "people"}
            </button>
            {searching && <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: colors.text_muted }}><SpinnerIcon size={14} /> {progress || "Searching..."} About 20 seconds per 30 names.</span>}
          </div>
          {error && <div role="alert" style={{ fontSize: "13px", color: "#CF222E" }}>{error}</div>}

          {result && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ fontSize: "13px" }}>Found <b>{uniqueMatches.length}</b> of {uniqueMatches.length + result.unmatched.length}.</div>
              <div style={{ border: `1px solid ${colors.border}`, borderRadius: "4px", maxHeight: "180px", overflowY: "auto" }}>
                {uniqueMatches.map(m => {
                  const already = inCrew(m.name);
                  return (
                    <label key={m.name} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "5px 8px", borderBottom: `1px solid ${colors.border}`, fontSize: "13px", cursor: already ? "default" : "pointer", color: already ? colors.text_muted : colors.text }}>
                      <input type="checkbox" checked={already || chosen.has(m.name)} disabled={already} onChange={() => toggle(m.name)} />
                      <span style={{ flex: 1 }}>{displayName(m.name)}</span>
                      {already ? <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "11px" }}><CheckIcon size={12} /> in crew</span>
                        : m.input.toLowerCase() !== m.name.toLowerCase() && <span style={{ fontSize: "11px", color: colors.text_muted, maxWidth: "150px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.input}>from "{m.input}"</span>}
                    </label>
                  );
                })}
              </div>
              {result.unmatched.length > 0 && (
                <details style={{ fontSize: "13px", color: colors.text_muted }}>
                  <summary style={{ cursor: "pointer" }}>Not found ({result.unmatched.length})</summary>
                  <div style={{ paddingTop: "4px", userSelect: "text" }}>{result.unmatched.join(", ")}</div>
                </details>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="button" onClick={() => { onAdd([...chosen], result); setText(""); setResult(null); }} disabled={chosen.size === 0} style={{ ...primaryBtn, opacity: chosen.size === 0 ? 0.6 : 1, cursor: chosen.size === 0 ? "not-allowed" : "pointer" }}>
                  Add {chosen.size} to crew
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
