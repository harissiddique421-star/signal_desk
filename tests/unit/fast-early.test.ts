import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { evaluateSignal } from "@/lib/engine/signal";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";
import { MODE_OVERRIDES } from "@/lib/config/presets";
import { generateSampleCandles } from "@/lib/providers/sample";
import { fastEvaluationTime } from "@/lib/server/analysis-service";
import { FAST_SCAN_AT_MS, msUntilFirstScan, SCAN_MAX_ATTEMPTS, SCAN_RETRY_MS } from "@/lib/client/scan-timing";
import { resolveSignal } from "@/lib/stats/resolve";

describe("FAST gives the signal one candle early", () => {
  const cfg = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.FAST });
  const minute = Date.UTC(2026, 9, 14, 9, 30, 0); // forming candle 09:30
  const now = minute + 45_000; // app checks at 09:30:45
  const source = { id: "t", name: "Test feed", verified: true, supportedMarketTypes: ["LIVE" as const] };

  it("scans at second 45 and every retry is before the candle closes", () => {
    expect(msUntilFirstScan(minute + 10_000, "FAST")).toBe(35_000);
    expect(msUntilFirstScan(minute + 50_000, "FAST")).toBe(55_000);
    expect(FAST_SCAN_AT_MS + (SCAN_MAX_ATTEMPTS - 1) * SCAN_RETRY_MS).toBeLessThan(60_000);
    // other modes are unchanged
    expect(msUntilFirstScan(minute + 59_000)).toBe(4_000);
  });

  it("moves the evaluation clock to the end of the minute only in its second half", () => {
    expect(fastEvaluationTime(now)).toBe(minute + 60_000);
    expect(fastEvaluationTime(minute + 5_000)).toBe(minute + 5_000);
  });

  it("returns CALL/PUT for the NEXT candle, before it starts", () => {
    const candles = generateSampleCandles("EUR/USD", now, 400); // includes the forming 09:30 candle
    const r = evaluateSignal({ candles, symbol: "EUR/USD", marketType: "LIVE", symbolSupported: true, source, analysisKind: "LIVE_FEED", now: fastEvaluationTime(now), config: cfg });
    expect(r.checks.filter((c) => !c.passed && (c.id.startsWith("data.") || c.id === "timing.window"))).toEqual([]);
    expect(r.signalCandleTime).toBe(minute);
    expect(r.entryWindowStart).toBe(minute + 60_000); // trade candle 09:31
    expect(r.entryWindowStart! - now).toBe(15_000); // 15 s countdown when the signal appears
    // the result is judged on the 09:31 candle
    expect(resolveSignal(candles, r.signalCandleTime!, r.decision as "CALL", minute + 125_000).detail).not.toBe("Trade candle has not closed yet");
  });

  it("still works when the feed has not published the forming candle", () => {
    const candles = generateSampleCandles("EUR/USD", now, 400).filter((c) => c.time < minute);
    const r = evaluateSignal({ candles, symbol: "EUR/USD", marketType: "LIVE", symbolSupported: true, source, analysisKind: "LIVE_FEED", now: fastEvaluationTime(now), config: cfg });
    expect(r.checks.filter((c) => !c.passed && (c.id.startsWith("data.") || c.id === "timing.window"))).toEqual([]);
    expect(r.entryWindowStart).toBe(minute + 60_000);
  });
});
