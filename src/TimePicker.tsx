import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The observation time: type it ("930", "9:30", "14:05", "2.30pm"), or pick
// it from a dropdown with quick choices, an hour grid and a 5-minute grid.
// The value is 24-hour "HH:MM" (or "" when not set), as ROAM expects.

interface Colors { border: string; text: string; text_muted: string; primary: string; input_bg: string; surface: string; modal_bg: string }

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/** "930" -> "09:30", "9:5" -> "09:05", "14" -> "14:00", "2.30pm" -> "14:30". */
export function parseTime(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return "";
  // "930", "1405": the last two digits are the minutes.
  const m = t.match(/^(\d{1,2})(\d{2})(am|pm|a|p)?$/) ?? t.match(/^(\d{1,2})(?:[:.h](\d{1,2}))?(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3];
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm.startsWith("p") && h < 12) h += 12;
    if (ampm.startsWith("a") && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return fmt(h, min);
}

function minutesAgo(n: number): string {
  const d = new Date(Date.now() - n * 60000);
  return fmt(d.getHours(), d.getMinutes());
}

export function TimePicker({ value, onChange, colors, background, className }: {
  value: string;
  onChange: (value: string) => void;
  colors: Colors;
  /** Field background (e.g. tinted when ROAM AI filled it) */
  background: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // The dropdown is drawn over the page (the form's panels clip their
  // contents), below the field, or above it when there's no room below.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const place = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const height = popRef.current?.offsetHeight ?? 300;
    const below = r.bottom + 4;
    const top = below + height > window.innerHeight - 8 && r.top - 4 - height > 8 ? r.top - 4 - height : below;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 308)), top });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hh, mm] = value ? value.split(":").map(Number) : [NaN, NaN];

  // Show the value when it changes from outside (Set to now, ROAM AI, a draft).
  useEffect(() => { setText(value); setInvalid(false); }, [value]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place);
    };
  }, [open]);

  const commit = () => {
    const parsed = parseTime(text);
    if (parsed === null) { setInvalid(true); return; }
    setInvalid(false);
    setText(parsed);
    if (parsed !== value) onChange(parsed);
  };
  const pick = (v: string, close = true) => { onChange(v); setText(v); setInvalid(false); if (close) setOpen(false); };

  const cell = (selected: boolean) => ({
    height: "28px", padding: 0, border: `1px solid ${selected ? colors.primary : colors.border}`, borderRadius: "4px",
    backgroundColor: selected ? colors.primary : colors.input_bg, color: selected ? "#FFFFFF" : colors.text,
    fontFamily: "inherit", fontSize: "12px", fontWeight: selected ? "bold" as const : 600, cursor: "pointer", fontVariantNumeric: "tabular-nums" as const,
  });
  const label = { fontSize: "10px", fontWeight: "bold" as const, letterSpacing: "0.4px", textTransform: "uppercase" as const, color: colors.text_muted, margin: "2px 0 4px" };

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <input
        type="text"
        inputMode="numeric"
        data-field="time"
        className={className}
        value={text}
        placeholder="HH:MM, e.g. 09:30"
        aria-label="Time"
        aria-invalid={invalid}
        title={invalid ? "Type a time like 09:30 or 14:05" : undefined}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={e => { setText(e.target.value); setInvalid(false); }}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(); setOpen(false); } if (e.key === "Tab") setOpen(false); }}
        style={{ width: "100%", padding: "6px 8px", border: `1px solid ${invalid ? "#CF222E" : colors.border}`, borderRadius: "4px", backgroundColor: background, color: colors.text, fontFamily: "inherit", fontSize: "13px", boxSizing: "border-box", fontVariantNumeric: "tabular-nums", userSelect: "text" }}
      />
      {open && createPortal(
        <div ref={popRef} role="dialog" aria-label="Choose a time" onMouseDown={e => e.preventDefault()}
          style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? 0, zIndex: 1500, width: "300px", padding: "10px", boxSizing: "border-box", backgroundColor: colors.modal_bg, border: `1px solid ${colors.border}`, borderRadius: "8px", boxShadow: "0 8px 24px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", gap: "4px" }}>
            {([["Now", 0], ["15 min ago", 15], ["30 min ago", 30], ["1 h ago", 60]] as [string, number][]).map(([l, n]) => (
              <button key={l} type="button" onClick={() => pick(minutesAgo(n))} style={{ ...cell(false), flex: 1, fontSize: "11px", fontWeight: "bold", color: colors.primary, borderColor: colors.primary }}>{l}</button>
            ))}
          </div>
          <div style={label}>Hour</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "4px" }}>
            {Array.from({ length: 24 }, (_, h) => (
              <button key={h} type="button" aria-label={`${pad(h)} hours`} aria-pressed={h === hh} onClick={() => pick(fmt(h, isNaN(mm) ? 0 : mm), false)} style={cell(h === hh)}>{pad(h)}</button>
            ))}
          </div>
          <div style={label}>Minute</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "4px" }}>
            {Array.from({ length: 12 }, (_, i) => i * 5).map(m => (
              <button key={m} type="button" aria-label={`${pad(m)} minutes`} aria-pressed={m === mm} onClick={() => pick(fmt(isNaN(hh) ? new Date().getHours() : hh, m))} style={cell(m === mm)}>:{pad(m)}</button>
            ))}
          </div>
          <div style={{ fontSize: "11px", color: colors.text_muted }}>Or type it, e.g. 0930 or 2.30pm.</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
