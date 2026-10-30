import { useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon, SpinnerIcon } from "./icons";
import type { SidebarColors } from "./MonthlySidebar";
import { displayName } from "./observationStats";

interface NameSearchModalProps {
  colors: SidebarColors & { modal_bg: string; modal_overlay: string };
  /** Names already seen in the report, searched instantly */
  knownNames: string[];
  current: string;
  /** Searches the whole report (opens Power BI in the background) */
  onSearchReport: (query: string) => Promise<string[]>;
  onChoose: (name: string) => void;
  onClose: () => void;
}

const MAX_SHOWN = 50;

/** Finds a colleague among thousands of names in the report: instant matches
 *  from names already loaded, plus a full search of the report on request. */
export function NameSearchModal({ colors, knownNames, current, onSearchReport, onChoose, onClose }: NameSearchModalProps) {
  const [query, setQuery] = useState("");
  const [reportResults, setReportResults] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Matches every word typed, in any order: "ryan abb" finds "Abbott, Ryan".
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const matches = (name: string) => words.every(w => name.toLowerCase().includes(w));
  const local = useMemo(() => (words.length ? knownNames.filter(matches) : []), [knownNames, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (reportResults ?? local).filter(n => !words.length || matches(n));

  const searchReport = async () => {
    const q = words.sort((a, b) => b.length - a.length)[0] ?? "";
    if (q.length < 2) { setError("Type at least 2 letters of the name."); return; }
    setSearching(true);
    setError("");
    try {
      setReportResults(await onSearchReport(q));
    } catch (e) {
      setError(`${e}`);
    } finally {
      setSearching(false);
    }
  };

  const btn = { padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, fontWeight: "bold" as const, color: colors.text, fontSize: "11px", cursor: "pointer", fontFamily: "inherit" };

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, backgroundColor: colors.modal_overlay, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "20px" }}>
      <div role="dialog" aria-label="Look up a colleague" style={{ backgroundColor: colors.modal_bg, color: colors.text, borderRadius: "8px", width: "100%", maxWidth: "420px", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.3)", border: `1px solid ${colors.border}` }}>
        <div style={{ padding: "6px 10px", minHeight: "36px", boxSizing: "border-box", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "13px", display: "flex", alignItems: "center" }}>
          Look up a colleague
        </div>
        <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "8px", minHeight: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", border: `1px solid ${colors.border}`, borderRadius: "4px", padding: "0 8px", backgroundColor: colors.input_bg }}>
            <span style={{ display: "flex", color: colors.text_muted }}><SearchIcon size={14} /></span>
            <input
              ref={inputRef}
              id="observer-search"
              value={query}
              onChange={e => { setQuery(e.target.value); setReportResults(null); setError(""); }}
              onKeyDown={e => { if (e.key === "Enter") { if (shown.length === 1) onChoose(shown[0]); else searchReport(); } }}
              placeholder="Type a name, e.g. Abbott Ryan"
              aria-label="Search names"
              style={{ flex: 1, minWidth: 0, border: "none", outline: "none", boxShadow: "none", padding: "7px 0", fontSize: "13px", fontFamily: "inherit", backgroundColor: "transparent", color: colors.text, userSelect: "text" }}
            />
          </div>

          <div role="listbox" aria-label="Matching names" style={{ flex: 1, minHeight: "120px", overflowY: "auto", border: `1px solid ${colors.border}`, borderRadius: "4px" }}>
            {searching ? (
              <div style={{ padding: "12px", fontSize: "13px", color: colors.text_muted, display: "flex", alignItems: "center", gap: "8px" }}>
                <SpinnerIcon /> Searching the Power BI report... this takes about 10 seconds.
              </div>
            ) : shown.length > 0 ? (
              shown.slice(0, MAX_SHOWN).map(name => (
                <button
                  key={name}
                  role="option"
                  aria-selected={name === current}
                  onClick={() => onChoose(name)}
                  className="icon-btn"
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", border: "none", borderBottom: `1px solid ${colors.border}`, background: "none", color: colors.text, fontFamily: "inherit", fontSize: "13px", fontWeight: name === current ? "bold" : "normal", cursor: "pointer" }}
                >
                  {displayName(name)}
                </button>
              ))
            ) : (
              <div style={{ padding: "12px", fontSize: "13px", color: colors.text_muted, lineHeight: 1.4 }}>
                {!words.length ? "Start typing to see matching names." : reportResults ? "No one in the report matches that. Check the spelling." : "No match among the names loaded so far. Search the whole report below."}
              </div>
            )}
            {shown.length > MAX_SHOWN && !searching && (
              <div style={{ padding: "6px 10px", fontSize: "11px", color: colors.text_muted }}>{shown.length - MAX_SHOWN} more - keep typing to narrow it down.</div>
            )}
          </div>

          {error && <div role="alert" style={{ fontSize: "13px", color: "#CF222E" }}>{error}</div>}

          <div style={{ display: "flex", gap: "8px", justifyContent: "space-between", alignItems: "center" }}>
            <button type="button" onClick={searchReport} disabled={searching} style={{ ...btn, cursor: searching ? "wait" : "pointer" }}>
              Search all of Power BI
            </button>
            <button type="button" onClick={onClose} style={{ ...btn, backgroundColor: colors.primary, borderColor: colors.primary, color: "#FFFFFF" }}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
