import { useEffect, useState } from "react";
import { MONTHLY_TARGET, tierFor, type MonthTier } from "./observationStats";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Status colours, matched to the app's existing green "Activated" button.
const STATUS = { none: "#CF222E", partial: "#BC5A00", met: "#1A7F37" };

// Secret easter egg: a month with CELEBRATION_THRESHOLD+ observations gets its
// own celebration emoji and animation. Click the card for a burst.
const CELEBRATIONS: { emoji: string; anim: string }[] = [
  { emoji: "🎉", anim: "pop" },
  { emoji: "🥳", anim: "bounce" },
  { emoji: "🎊", anim: "swing" },
  { emoji: "🙌", anim: "tada" },
  { emoji: "🏆", anim: "jelly" },
  { emoji: "🔥", anim: "heartbeat" },
  { emoji: "💪", anim: "wiggle" },
  { emoji: "🚀", anim: "launch" },
  { emoji: "🌟", anim: "spin" },
  { emoji: "👏", anim: "clap" },
  { emoji: "🎈", anim: "float" },
  { emoji: "💯", anim: "flip" },
];

// Burst directions (px) for the click celebration.
const BURST = [[-34, -10], [-20, -16], [-6, -18], [10, -16], [-28, 8], [-12, 12]];

const COLLAPSE_KEY = "roam_month_sidebar_collapsed";

/** Subset of App's theme colours the sidebar draws with. */
export interface SidebarColors {
  surface: string; border: string; text: string; text_muted: string; primary: string;
  input_bg: string; card_bg: string; debug_bg: string; debug_border: string; debug_text: string;
}

interface MonthlySidebarProps {
  year: number;
  /** 12 counts, January to December */
  counts: number[];
  now: Date;
  colors: SidebarColors;
  /** Shown only while the sidebar runs on sample data */
  onShuffle?: () => void;
}

export function MonthlySidebar({ year, counts, now, colors, onShuffle }: MonthlySidebarProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const [burstMonth, setBurstMonth] = useState<number | null>(null);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [collapsed]);

  useEffect(() => {
    if (burstMonth === null) return;
    const id = window.setTimeout(() => setBurstMonth(null), 1000);
    return () => window.clearTimeout(id);
  }, [burstMonth]);

  const currentYear = now.getFullYear();
  const lastMonth = year === currentYear ? now.getMonth() : year < currentYear ? 11 : -1;
  const isThisYear = year === currentYear;
  const thisMonthCount = isThisYear ? counts[now.getMonth()] : 0;
  const yearTotal = counts.reduce((a, b) => a + b, 0);

  const panel = { border: `1px solid ${colors.border}`, borderRadius: "8px", backgroundColor: colors.card_bg, overflow: "hidden" as const, position: "sticky" as const, top: "16px", flexShrink: 0, height: "calc(100vh - 32px)", boxSizing: "border-box" as const, display: "flex", flexDirection: "column" as const };
  const smallBtn = { padding: "2px 6px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.text, fontWeight: "bold" as const, fontSize: "11px", cursor: "pointer" };
  const statusColor = (tier: MonthTier) => tier === "none" ? STATUS.none : tier === "partial" ? STATUS.partial : STATUS.met;

  if (collapsed) {
    return (
      <div style={{ ...panel, width: "30px", alignItems: "center" }}>
        <div style={{ width: "100%", padding: "6px 0", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, display: "flex", justifyContent: "center" }}>
          <button onClick={() => setCollapsed(false)} title="Show monthly observations" style={{ ...smallBtn, padding: "0 4px" }}>»</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", paddingTop: "8px" }}>
          {counts.map((n, i) => {
            const tier = tierFor(n, i > lastMonth);
            return <div key={i} title={`${MONTH_FULL_NAMES[i]}: ${tier === "future" ? "-" : n}`} style={{ width: "10px", height: "10px", borderRadius: "2px", backgroundColor: tier === "future" ? colors.surface : statusColor(tier), border: tier === "future" ? `1px solid ${colors.border}` : "none", boxSizing: "border-box", outline: isThisYear && i === now.getMonth() ? `2px solid ${colors.primary}` : "none", outlineOffset: "1px" }} />;
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...panel, width: "150px" }}>
      <style>{`
        @keyframes roam-pop { 0%, 60%, 100% { transform: scale(1); } 15% { transform: scale(1.45); } 30% { transform: scale(0.9); } }
        @keyframes roam-bounce { 0%, 50%, 100% { transform: translateY(0); } 15% { transform: translateY(-5px); } 30% { transform: translateY(0); } 40% { transform: translateY(-2px); } }
        @keyframes roam-swing { 0%, 60%, 100% { transform: rotate(0); } 15% { transform: rotate(18deg); } 30% { transform: rotate(-14deg); } 45% { transform: rotate(6deg); } }
        @keyframes roam-tada { 0%, 60%, 100% { transform: scale(1) rotate(0); } 10%, 20% { transform: scale(0.9) rotate(-6deg); } 30%, 50% { transform: scale(1.2) rotate(6deg); } 40% { transform: scale(1.2) rotate(-6deg); } }
        @keyframes roam-jelly { 0%, 60%, 100% { transform: scale(1, 1); } 15% { transform: scale(1.3, 0.8); } 30% { transform: scale(0.85, 1.2); } 45% { transform: scale(1.08, 0.95); } }
        @keyframes roam-heartbeat { 0%, 50%, 100% { transform: scale(1); } 10%, 30% { transform: scale(1.3); } 20% { transform: scale(1); } }
        @keyframes roam-wiggle { 0%, 60%, 100% { transform: rotate(0); } 10%, 30%, 50% { transform: rotate(-15deg); } 20%, 40% { transform: rotate(15deg); } }
        @keyframes roam-launch { 0%, 70%, 100% { transform: translate(0, 0); opacity: 1; } 30% { transform: translate(8px, -14px); opacity: 0; } 31% { transform: translate(-8px, 14px); opacity: 0; } 55% { transform: translate(0, 0); opacity: 1; } }
        @keyframes roam-spin { 0% { transform: rotate(0); } 40%, 100% { transform: rotate(360deg); } }
        @keyframes roam-clap { 0%, 60%, 100% { transform: scale(1); } 10%, 30%, 50% { transform: scale(0.8); } 20%, 40% { transform: scale(1.15); } }
        @keyframes roam-float { 0%, 100% { transform: translateY(0) rotate(-4deg); } 50% { transform: translateY(-4px) rotate(4deg); } }
        @keyframes roam-flip { 0% { transform: rotateY(0); } 40%, 100% { transform: rotateY(360deg); } }
        @keyframes roam-fly { 0% { transform: translate(0, 0) scale(0.6); opacity: 1; } 100% { transform: translate(var(--dx), var(--dy)) scale(1.1); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .roam-celebrate, .roam-burst { animation: none !important; } }
      `}</style>

      <div style={{ padding: "6px 10px", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "13px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>{year} Observations</span>
        <button onClick={() => setCollapsed(true)} title="Hide monthly observations" style={{ ...smallBtn, padding: "0 4px" }}>«</button>
      </div>

      <div style={{ padding: "6px 10px", borderBottom: `1px solid ${colors.border}`, fontSize: "11px", color: colors.text_muted, display: "flex", flexDirection: "column", gap: "2px" }}>
        {isThisYear && <div><span style={{ color: colors.text, fontWeight: "bold" }}>{MONTH_FULL_NAMES[now.getMonth()]}:</span> {thisMonthCount >= MONTHLY_TARGET ? `${thisMonthCount}, target met` : `${thisMonthCount} of ${MONTHLY_TARGET}`}</div>}
        <div>{yearTotal} logged this year</div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px", display: "flex", flexDirection: "column", gap: "3px" }}>
        {counts.map((count, i) => {
          const tier = tierFor(count, i > lastMonth);
          const isCurrent = isThisYear && i === now.getMonth();
          const isCelebrate = tier === "celebrate";
          const celebration = CELEBRATIONS[i];
          const title = tier === "future"
            ? `${MONTH_FULL_NAMES[i]}: not started`
            : `${MONTH_FULL_NAMES[i]}: ${count} observation${count === 1 ? "" : "s"}${count >= MONTHLY_TARGET ? " (target met)" : ` (${MONTHLY_TARGET - count} short of ${MONTHLY_TARGET})`}`;

          return (
            <div
              key={i}
              title={title}
              onClick={isCelebrate ? () => setBurstMonth(i) : undefined}
              style={{
                position: "relative", flexShrink: 0,
                display: "flex", flexDirection: "column", gap: "3px",
                padding: "3px 6px 3px 8px", borderRadius: "4px",
                border: `1px solid ${isCurrent ? colors.primary : colors.border}`,
                boxShadow: isCurrent ? `inset 0 0 0 1px ${colors.primary}` : "none",
                backgroundColor: colors.input_bg,
                cursor: isCelebrate ? "pointer" : "default",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
              <span style={{ fontSize: "13px", lineHeight: "16px", fontWeight: "bold", color: tier === "future" ? colors.text_muted : colors.text }}>{MONTH_NAMES[i]}</span>
              <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                {isCelebrate && (
                  <span style={{ position: "relative", display: "inline-block", width: "16px", textAlign: "center", fontSize: "13px", lineHeight: 1 }}>
                    <span className="roam-celebrate" style={{ display: "inline-block", animation: `roam-${celebration.anim} ${celebration.anim === "float" ? "3s ease-in-out" : "2.6s ease-out"} infinite` }}>{celebration.emoji}</span>
                    {burstMonth === i && BURST.map(([dx, dy], p) => (
                      <span key={p} className="roam-burst" aria-hidden style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", ["--dx" as string]: `${dx}px`, ["--dy" as string]: `${dy}px`, animation: `roam-fly 0.9s ease-out ${p * 0.04}s both` }}>{celebration.emoji}</span>
                    ))}
                  </span>
                )}
                <span style={{
                  minWidth: "22px", padding: "1px 5px", boxSizing: "border-box", textAlign: "center", borderRadius: "4px",
                  fontSize: "11px", lineHeight: "14px", fontWeight: "bold", fontVariantNumeric: "tabular-nums",
                  backgroundColor: tier === "future" ? "transparent" : statusColor(tier),
                  color: tier === "future" ? colors.text_muted : "#FFFFFF",
                  border: tier === "future" ? `1px solid ${colors.border}` : `1px solid ${statusColor(tier)}`,
                }}>{tier === "future" ? "–" : count}</span>
              </span>
              </div>
              {/* Target progress: one segment per observation toward MONTHLY_TARGET */}
              <div style={{ display: "flex", gap: "2px" }}>
                {Array.from({ length: MONTHLY_TARGET }, (_, d) => (
                  <div key={d} style={{ flex: 1, height: "3px", borderRadius: "1px", backgroundColor: tier !== "future" && d < count ? statusColor(tier) : colors.surface, boxShadow: tier !== "future" && d < count ? "none" : `inset 0 0 0 1px ${colors.border}` }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: "6px 10px", borderTop: `1px solid ${colors.border}`, display: "flex", justifyContent: "space-between", fontSize: "11px", color: colors.text_muted }}>
        <Legend color={STATUS.none} label="0" />
        <Legend color={STATUS.partial} label="1–3" />
        <Legend color={STATUS.met} label={`${MONTHLY_TARGET}+`} />
      </div>

      {onShuffle && (
        <div style={{ padding: "6px 8px", backgroundColor: colors.debug_bg, borderTop: `1px solid ${colors.debug_border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "4px" }}>
          <span style={{ fontSize: "11px", fontWeight: "bold", color: colors.debug_text }}>SAMPLE DATA</span>
          <button onClick={onShuffle} style={{ ...smallBtn, backgroundColor: colors.card_bg, borderColor: colors.debug_text, color: colors.debug_text }}>Shuffle</button>
        </div>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "3px" }}>
      <span style={{ width: "8px", height: "8px", borderRadius: "2px", backgroundColor: color }} />{label}
    </span>
  );
}
