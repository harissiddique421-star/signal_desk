import { describe, expect, it } from "vitest";
import { anatomy, detectPatterns } from "@/lib/analysis/candles";
import { buildZones, detectBreakouts, findSwings, marketStructure, nearestZones, resample } from "@/lib/analysis/structure";
import type { Candle } from "@/lib/types";

const M = 60_000;
const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ time: i * M, open: o, high: h, low: l, close: cl });

describe("candle anatomy", () => {
  it("measures body and wicks", () => {
    const a = anatomy(c(0, 10, 14, 8, 12));
    expect(a.range).toBe(6);
    expect(a.body).toBe(2);
    expect(a.upperWick).toBe(2);
    expect(a.lowerWick).toBe(2);
    expect(a.bodyRatio).toBeCloseTo(1 / 3);
    expect(a.bullish).toBe(true);
  });
  it("handles zero-range candles", () => {
    expect(anatomy(c(0, 1, 1, 1, 1)).bodyRatio).toBe(0);
  });
});

describe("patterns", () => {
  const names = (cs: Candle[]) => detectPatterns(cs).map((p) => p.name);
  it("bullish and bearish engulfing", () => {
    expect(names([c(0, 10, 10.2, 9.4, 9.5), c(1, 9.4, 10.4, 9.3, 10.3)])).toContain("BULLISH_ENGULFING");
    expect(names([c(0, 9.5, 10.1, 9.4, 10), c(1, 10.1, 10.2, 9.2, 9.3)])).toContain("BEARISH_ENGULFING");
  });
  it("hammer and shooting star", () => {
    expect(names([c(0, 10, 10.05, 9, 10.04)]).concat()).toContain("HAMMER");
    expect(names([c(0, 10, 11, 9.97, 9.98)])).toContain("SHOOTING_STAR");
  });
  it("doji and marubozu", () => {
    expect(names([c(0, 10, 10.5, 9.5, 10.02)])).toContain("DOJI");
    expect(names([c(0, 10, 11, 10, 11)])).toContain("BULLISH_MARUBOZU");
  });
  it("inside bar and three soldiers / crows", () => {
    expect(names([c(0, 10, 11, 9, 10.5), c(1, 10.4, 10.8, 9.5, 10.6)])).toContain("INSIDE_BAR");
    expect(names([c(0, 10, 10.6, 9.95, 10.5), c(1, 10.5, 11.1, 10.45, 11), c(2, 11, 11.6, 10.95, 11.5)])).toContain("THREE_WHITE_SOLDIERS");
    expect(names([c(0, 11.5, 11.55, 10.9, 11), c(1, 11, 11.05, 10.4, 10.5), c(2, 10.5, 10.55, 9.9, 10)])).toContain("THREE_BLACK_CROWS");
  });
});

describe("swings and structure", () => {
  // zig-zag with rising highs and lows
  const prices = [10, 11, 12, 11, 10.5, 11.5, 13, 12, 11, 12, 14, 13, 12, 13, 13.5];
  const candles = prices.map((p, i) => c(i, p, p + 0.1, p - 0.1, p));
  it("finds confirmed fractal swings only", () => {
    const s = findSwings(candles, 2);
    expect(s.every((x) => x.index >= 2 && x.index <= candles.length - 3)).toBe(true);
    expect(s.filter((x) => x.kind === "HIGH").map((x) => x.index)).toEqual([2, 6, 10]);
    expect(s.filter((x) => x.kind === "LOW").map((x) => x.index)).toEqual([4, 8, 12]);
  });
  it("classifies an uptrend", () => {
    expect(marketStructure(findSwings(candles, 2)).state).toBe("UPTREND");
  });
  it("is UNCLEAR without enough swings", () => {
    expect(marketStructure([]).state).toBe("UNCLEAR");
  });
  it("swings are not changed by later data (no look-ahead beyond confirmation)", () => {
    const early = findSwings(candles.slice(0, 10), 2);
    const late = findSwings(candles, 2).filter((s) => s.index < 10 - 2);
    expect(late).toEqual(early);
  });
});

describe("zones", () => {
  it("merges nearby swings and labels support/resistance", () => {
    const sw = [
      { index: 1, time: 1, price: 1.0, kind: "LOW" as const },
      { index: 2, time: 2, price: 1.001, kind: "LOW" as const },
      { index: 3, time: 3, price: 1.02, kind: "HIGH" as const },
    ];
    const z = buildZones(sw, 1.01, 0.002);
    expect(z).toHaveLength(2);
    expect(z[0]).toMatchObject({ kind: "SUPPORT", touches: 2, low: 1.0, high: 1.001 });
    const n = nearestZones(z, 1.01);
    expect(n.support?.touches).toBe(2);
    expect(n.resistance?.mid).toBe(1.02);
  });
  it("does not chain into arbitrarily wide zones", () => {
    const sw = [0, 1, 2, 3, 4].map((k) => ({ index: k, time: k, price: 1 + k * 0.0015, kind: "HIGH" as const }));
    const z = buildZones(sw, 0.9, 0.002);
    expect(Math.max(...z.map((x) => x.high - x.low))).toBeLessThanOrEqual(0.002 + 1e-12);
  });
});

describe("breakouts", () => {
  const base = Array.from({ length: 21 }, (_, i) => c(i, 10, 10.5, 9.5, 10));
  it("bullish breakout and false breakout", () => {
    expect(detectBreakouts([...base, c(21, 10, 10.8, 9.9, 10.7)], 20).map((e) => e.kind)).toContain("BULLISH_BREAKOUT");
    expect(detectBreakouts([...base, c(21, 10, 10.8, 9.9, 10.2)], 20).map((e) => e.kind)).toContain("FALSE_BREAKOUT_UP");
    expect(detectBreakouts([...base, c(21, 10, 10.1, 9.2, 9.8)], 20).map((e) => e.kind)).toContain("FALSE_BREAKOUT_DOWN");
  });
  it("retest of a broken level", () => {
    const seq = [...base, c(21, 10, 10.9, 10, 10.8), c(22, 10.8, 10.9, 10.6, 10.7), c(23, 10.7, 10.8, 10.45, 10.65)];
    expect(detectBreakouts(seq, 20, 5).map((e) => e.kind)).toContain("BULLISH_RETEST");
  });
});

describe("resample", () => {
  it("builds complete 5m bars only", () => {
    const ones = Array.from({ length: 12 }, (_, i) => c(i, 10 + i, 10.5 + i, 9.5 + i, 10.2 + i));
    const r = resample(ones, 5);
    expect(r).toHaveLength(2); // minutes 0-4, 5-9; 10-11 incomplete → dropped
    expect(r[0]).toEqual({ time: 0, open: 10, high: 14.5, low: 9.5, close: 14.2 });
  });
});
