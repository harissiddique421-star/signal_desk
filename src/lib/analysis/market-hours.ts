/**
 * Regular FX market hours. The spot FX week runs from Sunday ~21:00/22:00 UTC
 * (17:00 New York, depending on daylight saving) to Friday 21:00/22:00 UTC.
 *
 * Some feeds (Twelve Data among them, measured in docs/RESEARCH.md §11) keep
 * publishing 1-minute candles through the weekend. Those minutes are not the
 * regular market the rules were tested on, so the engine treats them as closed.
 * The window is deliberately wide: Friday 21:00 UTC to Sunday 22:00 UTC.
 */
export function isFxWeekendClosed(ms: number): boolean {
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const h = d.getUTCHours();
  return day === 6 || (day === 5 && h >= 21) || (day === 0 && h < 22);
}
