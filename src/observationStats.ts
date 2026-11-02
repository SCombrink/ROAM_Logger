// Monthly observation counts for the sidebar tracker.
//
// For now this only produces randomised preview data so the look and feel can
// be reviewed. Once the design is signed off, getMonthlyCounts() will be backed
// by real observations scraped from ROAM and validated.

export const MONTHLY_TARGET = 4;
export const CELEBRATION_THRESHOLD = 10;

export type MonthTier = "future" | "none" | "partial" | "met" | "celebrate";

export function tierFor(count: number, isFuture: boolean): MonthTier {
  if (isFuture) return "future";
  if (count >= CELEBRATION_THRESHOLD) return "celebrate";
  if (count >= MONTHLY_TARGET) return "met";
  if (count > 0) return "partial";
  return "none";
}

// Weighted pick so every tier shows up regularly in the preview.
function randomCount(): number {
  const r = Math.random();
  if (r < 0.15) return 0;
  if (r < 0.4) return 1 + Math.floor(Math.random() * 3); // 1-3
  if (r < 0.8) return 4 + Math.floor(Math.random() * 6); // 4-9
  return 10 + Math.floor(Math.random() * 6); // 10-15
}

/**
 * Returns 12 counts (Jan..Dec) for the given year. Months after `now` are 0.
 * PREVIEW ONLY: values are random.
 */
export function generateRandomMonthlyCounts(year: number, now: Date = new Date()): number[] {
  return Array.from({ length: 12 }, (_, month) => {
    const isFuture = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth());
    return isFuture ? 0 : randomCount();
  });
}

/** Counts read from the Power BI report, per observer per month ("YYYY-MM"). */
export interface ObservationCounts {
  observers: Record<string, Record<string, number>>;
  fetchedAt: string;
  fromCache: boolean;
  ageHours: number | null;
  /** The report name matched to this user (chosen or detected from sign-in) */
  observer?: string | null;
  /** The user's own groups, e.g. { location: "Cape Town", discipline: "Mechanical" } */
  groups?: Record<string, string>;
  /** The user's own work email */
  email?: string | null;
}

/** The 12 monthly counts (Jan..Dec) for one observer in one year. */
export function countsForObserver(data: ObservationCounts, observer: string, year: number): number[] {
  const months = data.observers[observer] ?? {};
  return Array.from({ length: 12 }, (_, m) => Math.round(months[`${year}-${String(m + 1).padStart(2, "0")}`] ?? 0));
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" */
export function updatedAgo(iso: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** The report lists people as "Surname, Name"; show them as "Name Surname". */
export function displayName(reportName: string): string {
  const parts = reportName.split(",");
  return parts.length === 2 && parts[0].trim() && parts[1].trim() ? `${parts[1].trim()} ${parts[0].trim()}` : reportName;
}

/**
 * Observations submitted from this app, kept on this computer until the
 * official monthly counts include them (the official data is refreshed on a
 * schedule, so a new observation can take a while to appear there).
 * - "confirmed": ROAM showed its "saved successfully" message.
 * - "pending": the form was submitted but ROAM's confirmation was not seen.
 */
export interface LocalObservation {
  id: string;
  /** "YYYY-MM" of the observation's own date */
  month: string;
  status: "confirmed" | "pending";
  /** When it was submitted (ISO) */
  at: string;
  /** Official count for that month when it was submitted */
  baseline: number;
}

/** How long an entry is kept if the official counts never include it. */
const KEEP_DAYS = { confirmed: 30, pending: 14 };

/**
 * Drops entries the official counts now include, and entries past their
 * keep period. For each month, once the official count has risen by k above
 * the lowest baseline, the k oldest entries for that month are absorbed.
 */
export function reconcileLocal(entries: LocalObservation[], official: Record<string, number>, now: Date = new Date()): LocalObservation[] {
  const byMonth = new Map<string, LocalObservation[]>();
  for (const e of entries) byMonth.set(e.month, [...(byMonth.get(e.month) ?? []), e]);
  const kept: LocalObservation[] = [];
  for (const [month, list] of byMonth) {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const baseline = Math.min(...sorted.map(e => e.baseline));
    const absorbed = Math.max(0, Math.min(sorted.length, Math.round((official[month] ?? 0) - baseline)));
    for (const e of sorted.slice(absorbed)) {
      const ageDays = (now.getTime() - new Date(e.at).getTime()) / 86400000;
      if (ageDays <= KEEP_DAYS[e.status]) kept.push(e);
    }
  }
  return kept.sort((a, b) => a.at.localeCompare(b.at));
}

/** Per month of `year`: confirmed entries to add to the count, and pending ones (shown in blue). */
export function localAdjustments(entries: LocalObservation[], year: number): { extra: number[]; pending: number[] } {
  const extra = Array(12).fill(0), pending = Array(12).fill(0);
  for (const e of entries) {
    const [y, m] = e.month.split("-").map(Number);
    if (y !== year || !(m >= 1 && m <= 12)) continue;
    if (e.status === "confirmed") extra[m - 1]++; else pending[m - 1]++;
  }
  return { extra, pending };
}

/** Everyone in one of the user's groups (location or discipline). */
export interface Leaderboard {
  scope: string;
  group: string;
  observers: Record<string, Record<string, number>>;
  fetchedAt: string;
  complete: boolean;
  fromCache: boolean;
  ageHours: number | null;
}

export interface RankRow { rank: number; name: string; count: number; isMe: boolean }

/**
 * Ranks a group by one month's count (highest first; ties share a rank and
 * are listed by name). `myExtra` adds the user's own submissions the
 * official data does not include yet.
 */
export function rankLeaderboard(board: Leaderboard, month: string, me: string, myExtra = 0, topN = 10) {
  const rows = Object.entries(board.observers).map(([name, months]) => ({
    name,
    count: Math.round(months[month] ?? 0) + (name === me ? myExtra : 0),
    isMe: name === me,
  }));
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const ranked: RankRow[] = rows.map((r, i) => ({ ...r, rank: i > 0 && rows[i - 1].count === r.count ? 0 : i + 1 }));
  for (let i = 1; i < ranked.length; i++) if (ranked[i].rank === 0) ranked[i].rank = ranked[i - 1].rank;
  return {
    top: ranked.slice(0, topN),
    me: ranked.find(r => r.isMe) ?? null,
    total: ranked.length,
    onTarget: ranked.filter(r => r.count >= MONTHLY_TARGET).length,
  };
}

/** A crew member nudged recently is not offered another nudge for this long. */
export const NUDGE_COOLDOWN_DAYS = 3;

/** Days left in the month, today included. */
export function daysLeftInMonth(now: Date = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
}

/** The short Teams message sent to a crew member who is below target this month. */
export function nudgeMessage(reportName: string, count: number, now: Date = new Date()): string {
  const first = displayName(reportName).split(" ")[0];
  const month = now.toLocaleString("en", { month: "long" });
  const left = daysLeftInMonth(now);
  const logged = count === 0 ? "you haven't logged any observations yet this month" : `you've only logged ${count} observation${count === 1 ? "" : "s"} so far this month`;
  const time = left <= 1 ? `today is the last day of ${month}` : `there are only ${left} days left in ${month}`;
  const more = MONTHLY_TARGET - count;
  return `Hi ${first}, friendly nudge from ROAM Logger: I see ${logged} and ${time}. ${more} more and you're on target!`;
}
