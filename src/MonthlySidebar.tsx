import { useEffect, useState } from "react";
import { MONTHLY_TARGET, tierFor, type MonthTier } from "./observationStats";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Secret easter egg: one celebration per month, shown once a month hits
// CELEBRATION_THRESHOLD observations. `motion` picks the particle animation.
type Celebration = { label: string; particles: string[]; motion: "rise" | "fall" | "pop" };
const CELEBRATIONS: Celebration[] = [
  { label: "New Year fireworks", particles: ["🎆", "🎇", "✨"], motion: "pop" },
  { label: "Love is in the air", particles: ["💖", "💕", "💘"], motion: "rise" },
  { label: "Lucky streak", particles: ["🍀", "☘️", "🌈"], motion: "fall" },
  { label: "Egg-cellent work", particles: ["🐣", "🥚", "🌷"], motion: "pop" },
  { label: "In full bloom", particles: ["🌸", "🌼", "🌺"], motion: "fall" },
  { label: "Halfway hero", particles: ["🏆", "⭐", "🥇"], motion: "pop" },
  { label: "Liftoff", particles: ["🚀", "🌟", "💫"], motion: "rise" },
  { label: "Up, up and away", particles: ["🎈", "🎈", "🪁"], motion: "rise" },
  { label: "Star performer", particles: ["🌟", "⭐", "✨"], motion: "fall" },
  { label: "Spooktacular", particles: ["🎃", "👻", "🦇"], motion: "rise" },
  { label: "Confetti cannon", particles: ["🎊", "🎉", "🥳"], motion: "fall" },
  { label: "Season's greetings", particles: ["🎄", "❄️", "🎁"], motion: "fall" },
];

// Fixed particle layout so cards don't jitter between renders.
const PARTICLE_SLOTS = [
  { left: 8, delay: 0 }, { left: 26, delay: 0.9 }, { left: 44, delay: 0.4 },
  { left: 62, delay: 1.3 }, { left: 80, delay: 0.2 }, { left: 92, delay: 1.7 },
];

const COLLAPSE_KEY = "roam_month_sidebar_collapsed";

interface MonthlySidebarProps {
  year: number;
  /** 12 counts, January to December */
  counts: number[];
  now: Date;
  isDark: boolean;
  /** Shown only while the sidebar runs on preview data */
  onShuffle?: () => void;
}

export function MonthlySidebar({ year, counts, now, isDark, onShuffle }: MonthlySidebarProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const [burstMonth, setBurstMonth] = useState<number | null>(null);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [collapsed]);

  useEffect(() => {
    if (burstMonth === null) return;
    const id = window.setTimeout(() => setBurstMonth(null), 1400);
    return () => window.clearTimeout(id);
  }, [burstMonth]);

  const c = isDark ? {
    bg: "#202020", border: "#3A3A3A", text: "#E0E0E0", muted: "#A0A0A0",
    none: { fg: "#FF8A80", bg: "#3A1F1F", border: "#7A3A36" },
    partial: { fg: "#FFB74D", bg: "#3A2C18", border: "#7A5A26" },
    met: { fg: "#6FCF97", bg: "#1C3325", border: "#2F6B47" },
    future: { fg: "#6A6A6A", bg: "#252525", border: "#333333" },
    gold: "#E6C35C", goldBg: "linear-gradient(135deg, #2E2614 0%, #3D3216 50%, #2E2614 100%)",
    ring: "#8FB3C9",
  } : {
    bg: "#F3F4F5", border: "#DADDE0", text: "#2E2E2E", muted: "#595959",
    none: { fg: "#B3261E", bg: "#FDECEA", border: "#F0B4AE" },
    partial: { fg: "#A65300", bg: "#FFF1E0", border: "#F5C58F" },
    met: { fg: "#1E7B45", bg: "#E6F4EA", border: "#A5D6B5" },
    future: { fg: "#9A9A9A", bg: "#FAFAFA", border: "#E4E4E4" },
    gold: "#8A6400", goldBg: "linear-gradient(135deg, #FFF8E1 0%, #FFECB3 50%, #FFF8E1 100%)",
    ring: "#425563",
  };

  const currentYear = now.getFullYear();
  const currentMonth = year === currentYear ? now.getMonth() : year < currentYear ? 11 : -1;
  const yearTotal = counts.reduce((a, b) => a + b, 0);
  const monthsMet = counts.filter((n, i) => i <= currentMonth && n >= MONTHLY_TARGET).length;
  const thisMonthCount = year === currentYear ? counts[now.getMonth()] : 0;
  const toGo = Math.max(0, MONTHLY_TARGET - thisMonthCount);

  if (collapsed) {
    return (
      <aside style={{ width: "28px", flexShrink: 0, backgroundColor: c.bg, borderRight: `1px solid ${c.border}`, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "10px", gap: "6px", position: "sticky", top: 0, height: "100vh" }}>
        <button onClick={() => setCollapsed(false)} title="Show monthly tracker" style={{ border: "none", background: "none", color: c.muted, cursor: "pointer", fontSize: "14px", padding: "2px" }}>»</button>
        {counts.map((n, i) => {
          const tier = tierFor(n, i > currentMonth);
          return <div key={i} title={`${MONTH_FULL_NAMES[i]}: ${n}`} style={{ width: "10px", height: "10px", borderRadius: "50%", backgroundColor: tier === "celebrate" ? c.gold : tierColors(c, tier).fg, opacity: tier === "future" ? 0.4 : 1, outline: i === currentMonth && year === currentYear ? `2px solid ${c.ring}` : "none", outlineOffset: "1px" }} />;
        })}
      </aside>
    );
  }

  return (
    <aside style={{ width: "164px", flexShrink: 0, backgroundColor: c.bg, borderRight: `1px solid ${c.border}`, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", boxSizing: "border-box", padding: "12px 10px" }}>
      <style>{`
        @keyframes roam-rise { 0% { transform: translateY(14px) scale(0.6); opacity: 0; } 25% { opacity: var(--roam-peak); } 100% { transform: translateY(-30px) scale(1); opacity: 0; } }
        @keyframes roam-fall { 0% { transform: translateY(-18px) rotate(0deg); opacity: 0; } 25% { opacity: var(--roam-peak); } 100% { transform: translateY(30px) rotate(160deg); opacity: 0; } }
        @keyframes roam-pop { 0% { transform: scale(0.2); opacity: 0; } 40% { transform: scale(1.25); opacity: var(--roam-peak); } 100% { transform: scale(0.9); opacity: 0; } }
        @keyframes roam-shine { 0% { background-position: -120% 0; } 100% { background-position: 220% 0; } }
        @keyframes roam-wiggle { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-4deg); } 75% { transform: rotate(4deg); } }
        .roam-month-card { transition: transform 0.15s ease; }
        .roam-month-card:hover { transform: translateX(2px); }
        .roam-month-card.celebrate::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,${isDark ? 0.12 : 0.55}) 50%, transparent 70%); background-size: 200% 100%; animation: roam-shine 3.2s ease-in-out infinite; }
        .roam-month-card { --roam-peak: 0.45; }
        .roam-month-card.burst { --roam-peak: 1;  animation: roam-wiggle 0.35s ease-in-out 2; }
      `}</style>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "2px" }}>
        <div style={{ fontSize: "13px", fontWeight: "bold", color: c.text }}>{year} tracker</div>
        <button onClick={() => setCollapsed(true)} title="Hide monthly tracker" style={{ border: "none", background: "none", color: c.muted, cursor: "pointer", fontSize: "14px", padding: "0 2px" }}>«</button>
      </div>
      <div style={{ fontSize: "10px", color: c.muted, marginBottom: "10px", lineHeight: 1.4 }}>
        {yearTotal} logged · {monthsMet}/{Math.max(currentMonth + 1, 0)} months on target
        {year === currentYear && (
          <div style={{ color: toGo === 0 ? c.met.fg : c.partial.fg, fontWeight: "bold" }}>
            {toGo === 0 ? `${MONTH_FULL_NAMES[now.getMonth()]} target met ✓` : `${toGo} more for ${MONTH_FULL_NAMES[now.getMonth()]}`}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, overflowY: "auto", overflowX: "hidden", paddingRight: "2px" }}>
        {counts.map((count, i) => {
          const tier = tierFor(count, i > currentMonth);
          const isCurrent = year === currentYear && i === now.getMonth();
          const celebration = CELEBRATIONS[i];
          const tc = tierColors(c, tier);
          const isCelebrate = tier === "celebrate";
          const bursting = burstMonth === i;
          const title = isCelebrate
            ? `${MONTH_FULL_NAMES[i]}: ${count} observations. ${celebration.label}! (click to celebrate again)`
            : tier === "future" ? `${MONTH_FULL_NAMES[i]}: not started yet`
            : `${MONTH_FULL_NAMES[i]}: ${count} of ${MONTHLY_TARGET} observations${count >= MONTHLY_TARGET ? " - target met" : ""}`;

          return (
            <div
              key={i}
              className={`roam-month-card${isCelebrate ? " celebrate" : ""}${bursting ? " burst" : ""}`}
              title={title}
              onClick={isCelebrate ? () => setBurstMonth(i) : undefined}
              style={{
                position: "relative", overflow: "hidden", flexShrink: 0,
                minHeight: "34px", boxSizing: "border-box", padding: "4px 8px",
                borderRadius: "6px",
                background: isCelebrate ? c.goldBg : tc.bg,
                border: `1px solid ${isCelebrate ? c.gold : tc.border}`,
                borderLeft: `4px solid ${isCelebrate ? c.gold : tc.fg}`,
                boxShadow: isCurrent ? `0 0 0 2px ${c.ring}` : "none",
                cursor: isCelebrate ? "pointer" : "default",
                display: "flex", flexDirection: "column", justifyContent: "center",
              }}
            >
              {isCelebrate && PARTICLE_SLOTS.map((slot, p) => (
                <span
                  key={`${p}-${bursting ? "b" : "i"}`}
                  aria-hidden
                  style={{
                    position: "absolute", left: `${slot.left}%`, top: celebration.motion === "fall" ? "0" : celebration.motion === "pop" ? "20%" : "40%",
                    fontSize: bursting ? "15px" : "11px", pointerEvents: "none", zIndex: 0, filter: bursting ? "none" : "saturate(0.8)",
                    animation: `roam-${celebration.motion} ${bursting ? 1.1 : 2.4}s ease-out ${bursting ? slot.delay / 4 : slot.delay}s ${bursting ? 1 : "infinite"}`,
                    opacity: 0,
                  }}
                >{celebration.particles[p % celebration.particles.length]}</span>
              ))}

              <div style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "12px", fontWeight: isCurrent ? "bold" : 600, color: isCelebrate ? c.gold : tier === "future" ? tc.fg : c.text }}>
                  {MONTH_NAMES[i]}
                  {isCurrent && <span style={{ fontSize: "9px", marginLeft: "5px", padding: "0 4px", borderRadius: "3px", backgroundColor: c.ring, color: isDark ? "#1A1A1A" : "#FFFFFF", verticalAlign: "middle" }}>NOW</span>}
                </span>
                <span style={{ fontSize: "14px", fontWeight: "bold", color: isCelebrate ? c.gold : tc.fg, fontVariantNumeric: "tabular-nums" }}>
                  {tier === "future" ? "–" : count}
                </span>
              </div>

              {isCelebrate ? (
                <div style={{ position: "relative", zIndex: 1, fontSize: "9px", fontWeight: "bold", color: c.gold, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {celebration.particles[0]} {celebration.label}
                </div>
              ) : tier !== "future" && count < MONTHLY_TARGET && (
                <div style={{ position: "relative", display: "flex", gap: "2px", marginTop: "3px" }}>
                  {Array.from({ length: MONTHLY_TARGET }, (_, d) => (
                    <div key={d} style={{ flex: 1, height: "3px", borderRadius: "2px", backgroundColor: d < count ? tc.fg : tc.border }} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: "8px", justifyContent: "center", fontSize: "9px", color: c.muted, marginTop: "8px" }}>
        <Legend color={c.none.fg} label="0" />
        <Legend color={c.partial.fg} label="1–3" />
        <Legend color={c.met.fg} label={`${MONTHLY_TARGET}+`} />
      </div>
      {onShuffle && (
        <button onClick={onShuffle} title="Preview data only - regenerate random counts" style={{ marginTop: "6px", fontSize: "9px", padding: "3px 6px", border: `1px dashed ${c.border}`, borderRadius: "4px", background: "none", color: c.muted, cursor: "pointer" }}>
          🎲 Sample data · shuffle
        </button>
      )}
    </aside>
  );
}

function tierColors(c: { none: TierColor; partial: TierColor; met: TierColor; future: TierColor }, tier: MonthTier): TierColor {
  if (tier === "none") return c.none;
  if (tier === "partial") return c.partial;
  if (tier === "future") return c.future;
  return c.met;
}

type TierColor = { fg: string; bg: string; border: string };

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
      <span style={{ width: "7px", height: "7px", borderRadius: "50%", backgroundColor: color }} />{label}
    </span>
  );
}
