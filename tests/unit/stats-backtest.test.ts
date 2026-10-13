import { describe, expect, it } from "vitest";
import { summarize, wilson, type Outcome } from "@/lib/stats/performance";
import { runBacktest } from "@/lib/backtest/backtest";
import { upWave } from "../helpers/series";

const rec = (outs: Outcome[]) => outs.map((outcome, i) => ({ time: i, outcome }));

describe("summarize", () => {
  it("computes win rate excluding ties and unresolved", () => {
    const r = summarize(rec(["WIN", "LOSS", "TIE", "WIN", "UNRESOLVED"]), 0.8);
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(1);
    expect(r.ties).toBe(1);
    expect(r.unresolved).toBe(1);
    expect(r.winRate).toBeCloseTo(2 / 3, 10);
    expect(r.netUnits).toBeCloseTo(0.6, 10); // +0.8 −1 +0 +0.8
  });
  it("break-even win rate = 1/(1+payout)", () => {
    expect(summarize([], 0.85).breakEvenWinRate).toBeCloseTo(0.5405405, 6);
  });
  it("tracks losing streaks and drawdown", () => {
    const r = summarize(rec(["WIN", "LOSS", "LOSS", "LOSS", "WIN", "LOSS"]), 1);
    // equity: 1, 0, -1, -2, -1, -2 → peak 1, trough -2
    expect(r.maxLosingStreak).toBe(3);
    expect(r.maxDrawdownUnits).toBe(3);
    expect(r.equityCurve).toEqual([1, 0, -1, -2, -1, -2]);
  });
  it("sorts by time before computing streaks", () => {
    const r = summarize([{ time: 3, outcome: "LOSS" }, { time: 1, outcome: "LOSS" }, { time: 2, outcome: "WIN" }], 0.9);
    expect(r.maxLosingStreak).toBe(1);
  });
  it("always carries the past-results disclaimer and a small-sample caveat", () => {
    const r = summarize(rec(["WIN"]), 0.8);
    expect(r.caveats.join(" ")).toMatch(/Past results do not guarantee future results/);
    expect(r.caveats.join(" ")).toMatch(/Small sample/);
  });
  it("rejects nonsensical payouts", () => {
    expect(() => summarize([], 0)).toThrow();
    expect(() => summarize([], -1)).toThrow();
  });
  it("wilson interval", () => {
    const [lo, hi] = wilson(50, 100)!;
    expect(lo).toBeCloseTo(0.4038, 3);
    expect(hi).toBeCloseTo(0.5962, 3);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("runBacktest", () => {
  const candles = upWave(400);
  const src = { id: "test", name: "Test", verified: true, supportedMarketTypes: ["LIVE" as const] };

  it("produces trades whose outcomes follow the next candle", () => {
    const r = runBacktest({ candles, symbol: "X", marketType: "LIVE", source: src, payout: 0.85 });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      const next = candles.find((c) => c.time === t.signalCandleTime + 60_000)!;
      expect(t.entry).toBe(next.open);
      expect(t.exit).toBe(next.close);
      const up = next.close > next.open;
      if (next.close !== next.open) expect(t.outcome).toBe((t.decision === "CALL") === up ? "WIN" : "LOSS");
    }
    expect(r.inSample.sampleSize + r.outOfSample.sampleSize).toBe(r.overall.sampleSize);
    expect(r.barsEvaluated).toBe(r.trades.length + r.noTradeBars);
  });

  it("has no look-ahead: earlier trades are identical when later data is appended", () => {
    const short = runBacktest({ candles: candles.slice(0, 250), symbol: "X", marketType: "LIVE", source: src, payout: 0.85 });
    const long = runBacktest({ candles, symbol: "X", marketType: "LIVE", source: src, payout: 0.85 });
    const strip = (t: (typeof short.trades)[number]) => ({ ...t, segment: undefined });
    expect(long.trades.filter((t) => t.signalCandleTime <= candles[248].time).map(strip)).toEqual(short.trades.map(strip));
  });

  it("splits chronologically into in-sample and out-of-sample", () => {
    const r = runBacktest({ candles, symbol: "X", marketType: "LIVE", source: src, payout: 0.85, inSampleFraction: 0.5 });
    expect(r.splitTime).toBe(candles[200].time);
    expect(r.trades.filter((t) => t.segment === "IN_SAMPLE").every((t) => t.signalCandleTime < r.splitTime!)).toBe(true);
    expect(r.trades.filter((t) => t.segment === "OUT_OF_SAMPLE").every((t) => t.signalCandleTime >= r.splitTime!)).toBe(true);
  });
});
