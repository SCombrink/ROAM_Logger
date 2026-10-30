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
