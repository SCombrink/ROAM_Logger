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
