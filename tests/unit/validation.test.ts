import { describe, expect, it } from "vitest";
import { checkFreshness, closedCandlesOnly, inspectSeries, validateOhlc } from "@/lib/validation/candles";
import type { Candle } from "@/lib/types";

const M = 60_000;
const T0 = 1_760_000_040_000; // aligned to the minute

function series(n: number, start = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ time: start + i * M, open: 1.1, high: 1.101, low: 1.099, close: 1.1005 }));
}

describe("validateOhlc", () => {
  it("accepts a valid candle", () => {
    expect(validateOhlc({ time: T0, open: 1, high: 2, low: 0.5, close: 1.5 })).toEqual([]);
  });
  it("rejects high < low, high below body, low above body", () => {
    expect(validateOhlc({ time: T0, open: 1, high: 0.9, low: 1.1, close: 1 })).toContain("high < low");
    expect(validateOhlc({ time: T0, open: 1, high: 1.2, low: 0.9, close: 1.3 })).toContain("high below open/close");
    expect(validateOhlc({ time: T0, open: 1, high: 1.2, low: 1.05, close: 1.1 })).toContain("low above open/close");
  });
  it("rejects NaN, non-positive prices and non-integer time", () => {
    expect(validateOhlc({ time: T0, open: NaN, high: 1, low: 1, close: 1 }).length).toBeGreaterThan(0);
    expect(validateOhlc({ time: T0, open: 0, high: 1, low: 0, close: 1 }).length).toBeGreaterThan(0);
    expect(validateOhlc({ time: 1.5, open: 1, high: 1, low: 1, close: 1 })).toContain("time is not an integer epoch ms");
  });
});

describe("inspectSeries", () => {
  it("passes a clean series", () => {
    expect(inspectSeries(series(10), M, 10).ok).toBe(true);
  });
  it("detects missing candles within the lookback", () => {
    const s = series(10);
    s.splice(5, 2);
    const r = inspectSeries(s, M, 10);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([T0 + 5 * M, T0 + 6 * M]);
  });
  it("ignores gaps older than the lookback", () => {
    const s = series(30);
    s.splice(2, 1);
    expect(inspectSeries(s, M, 10).missing).toEqual([]);
  });
  it("detects duplicates, out-of-order and misaligned timestamps", () => {
    const s = series(5);
    s[2] = { ...s[2], time: s[1].time };
    expect(inspectSeries(s, M, 5).duplicates.length).toBe(1);
    const o = series(5);
    [o[3], o[4]] = [o[4], o[3]];
    expect(inspectSeries(o, M, 5).outOfOrder.length).toBe(1);
    const m = series(5);
    m[4] = { ...m[4], time: m[4].time + 1234 };
    expect(inspectSeries(m, M, 5).misaligned.length).toBe(1);
  });
});

describe("freshness and closed candles", () => {
  const s = series(5); // last candle opens at T0+4M, closes at T0+5M
  it("drops the still-forming candle", () => {
    const now = T0 + 4 * M + 30_000; // middle of last candle
    expect(closedCandlesOnly(s, M, now).length).toBe(4);
  });
  it("is fresh just after the last candle closes", () => {
    const r = checkFreshness(s, M, T0 + 5 * M + 2000, 75);
    expect(r.fresh).toBe(true);
    expect(r.ageSeconds).toBe(2);
  });
  it("is stale when the last candle is too old", () => {
    const r = checkFreshness(s, M, T0 + 5 * M + 120_000, 75);
    expect(r.fresh).toBe(false);
    expect(r.detail).toMatch(/closed 120s ago/);
  });
  it("is stale when the just-finished candle is missing even if age is within limit", () => {
    // now is 50s into the minute after next: expected last open = T0+5M, but series ends at T0+4M
    const r = checkFreshness(s, M, T0 + 6 * M + 10_000, 75);
    expect(r.fresh).toBe(false);
    expect(r.detail).toMatch(/missing/);
  });
  it("reports empty input", () => {
    expect(checkFreshness([], M, T0, 75).fresh).toBe(false);
  });
});
