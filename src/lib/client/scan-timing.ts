/**
 * When the app checks the market after each candle closes.
 *
 * Bug fixed (2026-10-14): the scan started 4 s after the close and retried every
 * 5 s (4 s, 9 s, 14 s), while the v2 entry window closed 10 s after the close. If
 * the feed published the finished candle late, the only fresh answer arrived after
 * the window had shut, so a valid v2 setup could never be shown. The attempts now
 * finish well inside every mode's entry window (see tests/unit/scan-timing.test.ts).
 * The number of attempts stays at 3 to respect Twelve Data's per-minute credit limit.
 */
export const SCAN_FIRST_OFFSET_MS = 3_000;
export const SCAN_RETRY_MS = 4_000;
export const SCAN_MAX_ATTEMPTS = 3;
/** Network + server time budget we leave between the last attempt and the window end */
export const SCAN_LATENCY_BUDGET_MS = 3_000;

export function lastAttemptOffsetMs(): number {
  return SCAN_FIRST_OFFSET_MS + (SCAN_MAX_ATTEMPTS - 1) * SCAN_RETRY_MS;
}

/** Delay from `serverNow` to the first check after the next candle closes. */
export function msUntilFirstScan(serverNow: number): number {
  return 60_000 - (serverNow % 60_000) + SCAN_FIRST_OFFSET_MS;
}

/** Feed timing counters kept on the device: on which attempt the finished candle was available. */
export interface FeedStats {
  attempt1: number;
  attempt2: number;
  attempt3: number;
  missed: number;
}
const FKEY = "signal-desk:feed-stats:v1";
export const EMPTY_FEED_STATS: FeedStats = { attempt1: 0, attempt2: 0, attempt3: 0, missed: 0 };

export function recordFeedOutcome(s: FeedStats, freshOnAttempt: number | null): FeedStats {
  if (freshOnAttempt === null) return { ...s, missed: s.missed + 1 };
  const k = (`attempt${Math.min(3, Math.max(1, freshOnAttempt))}`) as keyof FeedStats;
  return { ...s, [k]: s[k] + 1 };
}

export const feedStatsStore = {
  load(): FeedStats {
    try {
      return { ...EMPTY_FEED_STATS, ...JSON.parse(window.localStorage.getItem(FKEY) ?? "{}") };
    } catch {
      return EMPTY_FEED_STATS;
    }
  },
  save(s: FeedStats) {
    try {
      window.localStorage.setItem(FKEY, JSON.stringify(s));
    } catch {
      /* storage unavailable */
    }
  },
};
