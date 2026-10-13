import { describe, expect, it } from "vitest";
import { evaluateSignal, type SourceInfo } from "@/lib/engine/signal";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";
import { MODE_OVERRIDES } from "@/lib/config/presets";
import type { Candle } from "@/lib/types";
import { M, T0, mirror, upWave } from "../helpers/series";

const LIVE: SourceInfo = { id: "test", name: "Test feed", verified: true, supportedMarketTypes: ["LIVE"] };
const V2 = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.V2 });
const V1 = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.STRICT });

/** Calm drifting series, then one large decisive up-candle that closes far above the upper band. */
function stretchedUp(start = T0): Candle[] {
  const base = upWave(220, 0.00001, 0.0002, 16).map((c, i) => ({ ...c, time: start + i * M }));
  const last = base[base.length - 1];
  const open = last.close;
  const close = open + 0.0012; // several ATRs
  base.push({ time: last.time + M, open, high: close + 0.00004, low: open - 0.00002, close });
  return base;
}

function run(candles: Candle[], config = V2, delayMs = 1000) {
  return evaluateSignal({ candles, symbol: "EUR/USD", marketType: "LIVE", symbolSupported: true, source: LIVE, analysisKind: "LIVE_FEED", now: candles[candles.length - 1].time + M + delayMs, config });
}
const failed = (r: ReturnType<typeof run>) => r.checks.filter((c) => !c.passed).map((c) => c.id);

describe("FADE_V2 strategy", () => {
  it("fades a stretched up-candle with PUT and records the readings behind it", () => {
    const r = run(stretchedUp());
    expect(failed(r)).toEqual([]);
    expect(r.decision).toBe("PUT");
    expect(r.ruleVersion).toBe("rules-v2-fade");
    expect(r.metrics).toMatchObject({ lastCandleDir: 1 });
    expect(r.metrics!.bbPercentB).toBeGreaterThan(1);
    expect(r.metrics!.lastRangeAtr).toBeGreaterThanOrEqual(2);
    expect(r.metrics!.rsi).toBeGreaterThanOrEqual(70);
    expect(r.evidence.find((e) => e.id === "setup.fade")?.direction).toBe("BEARISH");
  });

  it("fades a stretched down-candle with CALL (mirror image)", () => {
    expect(run(mirror(stretchedUp())).decision).toBe("CALL");
  });

  it("returns NO TRADE when the last candle closes inside the bands", () => {
    const calm = upWave(221, 0.00001, 0.0002, 16);
    const r = run(calm);
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toContain("fade.stretch");
  });

  it("does not trade during the blocked rollover hours (21–23 UTC)", () => {
    // Shift the series so the signal candle opens at 21:30 UTC.
    const s = stretchedUp();
    const lastOpen = s[s.length - 1].time;
    const target = Date.UTC(2025, 9, 9, 21, 30);
    const shifted = s.map((c) => ({ ...c, time: c.time - lastOpen + target }));
    const r = run(shifted);
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toEqual(["session.hours"]);
  });

  it("is still valid at the app's last scan attempt (11 s) and expires after 15 s", () => {
    expect(run(stretchedUp(), V2, 11_000).decision).toBe("PUT");
    const r = run(stretchedUp(), V2, 16_000);
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toEqual(["timing.window"]);
  });

  it("ignores the still-forming candle (no look-ahead)", () => {
    const s = stretchedUp();
    const last = s[s.length - 1];
    // A forming candle that has already reversed hard must not change the decision.
    const forming: Candle = { time: last.time + M, open: last.close, high: last.close, low: last.close - 0.003, close: last.close - 0.003 };
    const a = run(s);
    const b = evaluateSignal({ candles: [...s, forming], symbol: "EUR/USD", marketType: "LIVE", symbolSupported: true, source: LIVE, analysisKind: "LIVE_FEED", now: last.time + M + 1000, config: V2 });
    expect(b.decision).toBe(a.decision);
    expect(b.signalCandleTime).toBe(last.time);
  });

  it("needs a decisive body: a long-wick candle of the same range is not faded", () => {
    const s = stretchedUp();
    const last = s[s.length - 1];
    // Same high/low, but the close sits near the open (body < 50 % of range).
    s[s.length - 1] = { ...last, close: last.open + 0.0003, high: last.open + 0.0012 };
    const r = run(s);
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toEqual(expect.arrayContaining(["fade.body"]));
  });

  it("never issues a tradable signal from unverified (sample) data", () => {
    const r = evaluateSignal({ candles: stretchedUp(), symbol: "SAMPLE", marketType: "LIVE", symbolSupported: true, source: { ...LIVE, verified: false }, analysisKind: "SAMPLE", now: stretchedUp()[220].time + M + 1000, config: V2 });
    expect(r.decision).toBe("NO_TRADE");
    expect(r.engineDecision).toBe("PUT");
  });
});

describe("regression: v1 vs v2 on the same stretched candle", () => {
  it("v1 blocks it as a shock candle; v2 trades against it", () => {
    const s = stretchedUp();
    expect(failed(run(s, V1))).toContain("vol.shock");
    expect(run(s, V2).decision).toBe("PUT");
  });

  it("the default mode for new API requests is V2", async () => {
    const { AnalyzeRequestSchema } = await import("@/lib/api/schemas");
    expect(AnalyzeRequestSchema.parse({ provider: "sample", symbol: "EUR/USD", marketType: "LIVE" }).mode).toBe("V2");
  });
});

describe("backtest scores entry delay", () => {
  it("records both the on-time and the one-candle-late result of each trade", async () => {
    const { runBacktest } = await import("@/lib/backtest/backtest");
    const s = stretchedUp();
    const last = s[s.length - 1];
    // Trade candle falls back (PUT wins on time); the following candle rises (PUT loses if entered late).
    const c1: Candle = { time: last.time + M, open: last.close, high: last.close + 0.00002, low: last.close - 0.0004, close: last.close - 0.0003 };
    const c2: Candle = { time: c1.time + M, open: c1.close, high: c1.close + 0.0005, low: c1.close - 0.00002, close: c1.close + 0.0004 };
    const r = runBacktest({ candles: [...s, c1, c2], symbol: "EUR/USD", marketType: "LIVE", source: LIVE, payout: 0.85, config: V2 });
    const t = r.trades.find((x) => x.signalCandleTime === last.time);
    expect(t).toMatchObject({ decision: "PUT", outcome: "WIN", lateOutcome: "LOSS" });
    expect(r.overallLate.losses).toBeGreaterThanOrEqual(1);
  });
});
