import { describe, expect, it } from "vitest";
import fixture from "../fixtures/indicators.json";
import { atr, bollinger, ema, macd, percentileRank, rsi, sma } from "@/lib/indicators";
import type { Candle } from "@/lib/types";

const candles = fixture.candles as Candle[];
const closes = candles.map((c) => c.close);

function expectSeriesClose(actual: (number | null)[], expected: (number | null)[], digits = 10) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => {
    if (expected[i] === null) expect(v, `index ${i}`).toBeNull();
    else expect(v as number, `index ${i}`).toBeCloseTo(expected[i] as number, digits);
  });
}

describe("SMA / EMA", () => {
  it("SMA hand-computed", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("EMA is SMA-seeded then smoothed (hand-computed)", () => {
    // seed = mean(1,2,3) = 2, k = 0.5 → 3, 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("EMA returns all null when history is too short", () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });
  it("matches the independent pandas reference (EMA 9 / 21)", () => {
    expectSeriesClose(ema(closes, 9), fixture.ema9);
    expectSeriesClose(ema(closes, 21), fixture.ema21);
  });
  it("rejects invalid periods", () => {
    expect(() => ema([1, 2, 3], 0)).toThrow();
    expect(() => sma([1, 2, 3], 1.5)).toThrow();
  });
});

describe("RSI (Wilder)", () => {
  it("matches the classic Wilder worked example (exact arithmetic)", () => {
    // The widely published version of this example (≈70.53, 66.32 …) rounds the
    // average gain/loss to 4 dp before dividing; these are the unrounded values,
    // independently recomputed in Python.
    const d = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
    const r = rsi(d, 14);
    expect(r[13]).toBeNull();
    expect(r[14] as number).toBeCloseTo(70.464135, 5);
    expect(r[15] as number).toBeCloseTo(66.249619, 5);
    expect(r[19] as number).toBeCloseTo(57.915021, 5);
  });
  it("is 100 for strictly rising and 50 for flat input", () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => i + 1), 14)[19]).toBe(100);
    expect(rsi(new Array(20).fill(5), 14)[19]).toBe(50);
  });
  it("matches the pandas reference", () => {
    expectSeriesClose(rsi(closes, 14), fixture.rsi14, 8);
  });
});

describe("MACD", () => {
  it("matches the pandas reference", () => {
    const m = macd(closes, 12, 26, 9);
    expectSeriesClose(m.macd, fixture.macd, 12);
    expectSeriesClose(m.signal, fixture.macdSignal, 12);
    expectSeriesClose(m.histogram, fixture.macdHist, 12);
  });
  it("requires fast < slow", () => {
    expect(() => macd(closes, 26, 12, 9)).toThrow();
  });
});

describe("Bollinger Bands", () => {
  it("uses population standard deviation (hand-computed on 1..20)", () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    const b = bollinger(v, 20, 2);
    const sd = Math.sqrt((20 * 20 - 1) / 12);
    expect(b.middle[19]).toBeCloseTo(10.5, 12);
    expect(b.upper[19] as number).toBeCloseTo(10.5 + 2 * sd, 12);
    expect(b.lower[19] as number).toBeCloseTo(10.5 - 2 * sd, 12);
  });
  it("matches the pandas reference", () => {
    const b = bollinger(closes, 20, 2);
    expectSeriesClose(b.middle, fixture.bbMiddle, 12);
    expectSeriesClose(b.upper, fixture.bbUpper, 12);
    expectSeriesClose(b.lower, fixture.bbLower, 12);
  });
});

describe("ATR (Wilder)", () => {
  it("hand-computed small case", () => {
    const c: Candle[] = [
      { time: 0, open: 10, high: 11, low: 9, close: 10 }, // TR 2
      { time: 60000, open: 10, high: 12, low: 10, close: 11 }, // TR 2
      { time: 120000, open: 11, high: 11, low: 8, close: 9 }, // TR 3
    ];
    const a = atr(c, 2);
    expect(a[0]).toBeNull();
    expect(a[1]).toBe(2);
    expect(a[2]).toBe(2.5);
  });
  it("matches the pandas reference", () => {
    expectSeriesClose(atr(candles, 14), fixture.atr14, 12);
  });
});

describe("No look-ahead", () => {
  it("values at index i do not change when future data is appended", () => {
    const half = closes.slice(0, 150);
    const full = closes;
    const pairs: [(number | null)[], (number | null)[]][] = [
      [ema(half, 21), ema(full, 21)],
      [rsi(half, 14), rsi(full, 14)],
      [macd(half).histogram, macd(full).histogram],
      [bollinger(half).upper, bollinger(full).upper],
      [atr(candles.slice(0, 150)), atr(candles)],
    ];
    for (const [a, b] of pairs) expect(a).toEqual(b.slice(0, 150));
  });
});

describe("percentileRank", () => {
  it("ranks with mid-point ties", () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(62.5);
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0);
    expect(Number.isNaN(percentileRank([], 1))).toBe(true);
  });
});
