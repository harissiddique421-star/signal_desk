import type { Candle } from "../types";

export interface CandleIssue {
  index: number;
  time: number;
  problem: string;
}

/** Validate one candle's OHLC relationships. Returns problems, empty if valid. */
export function validateOhlc(c: Candle): string[] {
  const problems: string[] = [];
  const nums: [string, number][] = [
    ["open", c.open],
    ["high", c.high],
    ["low", c.low],
    ["close", c.close],
  ];
  for (const [k, v] of nums) {
    if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`${k} is not a finite number`);
    else if (v <= 0) problems.push(`${k} must be positive`);
  }
  if (!Number.isFinite(c.time) || !Number.isInteger(c.time)) problems.push("time is not an integer epoch ms");
  if (problems.length) return problems;
  if (c.high < c.low) problems.push("high < low");
  if (c.high < Math.max(c.open, c.close)) problems.push("high below open/close");
  if (c.low > Math.min(c.open, c.close)) problems.push("low above open/close");
  if (c.volume !== undefined && (!Number.isFinite(c.volume) || c.volume < 0)) problems.push("volume invalid");
  return problems;
}

export interface SeriesReport {
  ok: boolean;
  invalid: CandleIssue[];
  misaligned: CandleIssue[];
  duplicates: CandleIssue[];
  outOfOrder: CandleIssue[];
  /** Missing candle open times (UTC ms) inside the inspected window */
  missing: number[];
}

/**
 * Check a candle series for structural problems.
 * @param gapLookback only the last N candles are checked for missing bars
 */
export function inspectSeries(candles: Candle[], tfMs: number, gapLookback: number): SeriesReport {
  const invalid: CandleIssue[] = [];
  const misaligned: CandleIssue[] = [];
  const duplicates: CandleIssue[] = [];
  const outOfOrder: CandleIssue[] = [];
  const missing: number[] = [];

  candles.forEach((c, i) => {
    const p = validateOhlc(c);
    if (p.length) invalid.push({ index: i, time: c.time, problem: p.join("; ") });
    if (Number.isFinite(c.time) && c.time % tfMs !== 0) {
      misaligned.push({ index: i, time: c.time, problem: "timestamp not aligned to timeframe" });
    }
    if (i > 0) {
      const prev = candles[i - 1].time;
      if (c.time === prev) duplicates.push({ index: i, time: c.time, problem: "duplicate timestamp" });
      else if (c.time < prev) outOfOrder.push({ index: i, time: c.time, problem: "timestamps not ascending" });
    }
  });

  const start = Math.max(1, candles.length - gapLookback);
  for (let i = start; i < candles.length; i++) {
    const prev = candles[i - 1].time;
    const cur = candles[i].time;
    if (cur > prev) {
      for (let t = prev + tfMs; t < cur; t += tfMs) {
        missing.push(t);
        if (missing.length > 1000) break;
      }
    }
  }

  return {
    ok: !invalid.length && !misaligned.length && !duplicates.length && !outOfOrder.length && !missing.length,
    invalid,
    misaligned,
    duplicates,
    outOfOrder,
    missing,
  };
}

/** A candle is closed once its full timeframe has elapsed. */
export function isClosed(c: Candle, tfMs: number, now: number): boolean {
  return c.time + tfMs <= now;
}

/**
 * Drop any candle that has not finished yet (providers often include the bar
 * that is still forming). Using it would be look-ahead bias.
 */
export function closedCandlesOnly(candles: Candle[], tfMs: number, now: number): Candle[] {
  return candles.filter((c) => isClosed(c, tfMs, now));
}

export interface FreshnessReport {
  fresh: boolean;
  /** Seconds since the last closed candle closed */
  ageSeconds: number | null;
  /** The candle we expected to be the last closed one */
  expectedLastOpen: number;
  detail: string;
}

/**
 * The last closed candle must be the one that just finished
 * (open time = start of previous minute) and its close must be recent.
 */
export function checkFreshness(
  candles: Candle[],
  tfMs: number,
  now: number,
  maxStalenessSeconds: number,
): FreshnessReport {
  const expectedLastOpen = Math.floor(now / tfMs) * tfMs - tfMs;
  if (!candles.length) {
    return { fresh: false, ageSeconds: null, expectedLastOpen, detail: "No closed candles available" };
  }
  const last = candles[candles.length - 1];
  const closeTime = last.time + tfMs;
  const ageSeconds = Math.round((now - closeTime) / 1000);
  if (last.time > now) {
    return { fresh: false, ageSeconds, expectedLastOpen, detail: "Last candle timestamp is in the future (clock or feed error)" };
  }
  if (ageSeconds > maxStalenessSeconds) {
    return {
      fresh: false,
      ageSeconds,
      expectedLastOpen,
      detail: `Last closed candle closed ${ageSeconds}s ago (limit ${maxStalenessSeconds}s)`,
    };
  }
  if (last.time !== expectedLastOpen) {
    return {
      fresh: false,
      ageSeconds,
      expectedLastOpen,
      detail: `Most recent closed candle is missing (expected ${new Date(expectedLastOpen).toISOString()})`,
    };
  }
  return { fresh: true, ageSeconds, expectedLastOpen, detail: `Last candle closed ${ageSeconds}s ago` };
}
