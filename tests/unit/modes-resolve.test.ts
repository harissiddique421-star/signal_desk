import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { evaluateSignal } from "@/lib/engine/signal";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";
import { MODE_OVERRIDES } from "@/lib/config/presets";
import { resolveSignal } from "@/lib/stats/resolve";
import { runBacktest } from "@/lib/backtest/backtest";
import { generateSampleCandles } from "@/lib/providers/sample";
import { sortMajorsFirst } from "@/lib/providers/twelvedata";
import { afterClose, M, upWave } from "../helpers/series";

const src = { id: "t", name: "Test", verified: true, supportedMarketTypes: ["LIVE" as const] };
const cfg = (mode: "STRICT" | "NORMAL") => RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES[mode] });

describe("resolveSignal", () => {
  const candles = [
    { time: 0, open: 1, high: 1.2, low: 0.9, close: 1.1 },
    { time: M, open: 1.1, high: 1.3, low: 1.0, close: 1.2 }, // up
    { time: 2 * M, open: 1.2, high: 1.25, low: 1.0, close: 1.05 }, // down
    { time: 3 * M, open: 1.05, high: 1.1, low: 1.0, close: 1.05 }, // flat
  ];
  it("uses the candle after the signal candle (open → close)", () => {
    expect(resolveSignal(candles, 0, "CALL", 3 * M)).toMatchObject({ status: "RESOLVED", outcome: "WIN", entry: 1.1, exit: 1.2 });
    expect(resolveSignal(candles, 0, "PUT", 3 * M)).toMatchObject({ outcome: "LOSS" });
    expect(resolveSignal(candles, M, "PUT", 4 * M)).toMatchObject({ outcome: "WIN" });
    expect(resolveSignal(candles, 2 * M, "CALL", 5 * M)).toMatchObject({ outcome: "TIE" });
  });
  it("stays pending until the trade candle has closed and been published", () => {
    expect(resolveSignal(candles, 0, "CALL", 2 * M - 1).status).toBe("PENDING");
    expect(resolveSignal(candles, 3 * M, "CALL", 10 * M).status).toBe("PENDING");
  });
  it("is unavailable when the feed has a gap at that minute", () => {
    const gapped = candles.filter((c) => c.time !== M);
    expect(resolveSignal(gapped, 0, "CALL", 5 * M).status).toBe("UNAVAILABLE");
  });
});

describe("signal modes", () => {
  it("NORMAL is a superset of STRICT on the same data (more or equal signals)", () => {
    const candles = generateSampleCandles("SAMPLE-TREND", 1_760_000_000_000, 900).slice(0, -1);
    const s = runBacktest({ candles, symbol: "X", marketType: "LIVE", source: src, payout: 0.85, config: cfg("STRICT") });
    const n = runBacktest({ candles, symbol: "X", marketType: "LIVE", source: src, payout: 0.85, config: cfg("NORMAL") });
    expect(n.overall.sampleSize).toBeGreaterThanOrEqual(s.overall.sampleSize);
    const strictTimes = new Set(s.trades.map((t) => t.signalCandleTime));
    const normalTimes = new Set(n.trades.map((t) => t.signalCandleTime));
    for (const t of strictTimes) expect(normalTimes.has(t)).toBe(true);
  });

  it("NORMAL tolerates a few missing quiet minutes; STRICT does not", () => {
    const base = upWave().slice(0, 155);
    const gapped = [...base.slice(0, 140), ...base.slice(141)];
    const now = afterClose(base);
    const run = (mode: "STRICT" | "NORMAL") =>
      evaluateSignal({ candles: gapped, symbol: "X", marketType: "LIVE", symbolSupported: true, source: src, analysisKind: "LIVE_FEED", now, config: cfg(mode) });
    expect(run("STRICT").checks.find((c) => c.id === "data.gaps")?.passed).toBe(false);
    expect(run("NORMAL").checks.find((c) => c.id === "data.gaps")?.passed).toBe(true);
  });

  it("NORMAL keeps the entry window open longer", () => {
    expect(cfg("NORMAL").entryWindowSeconds).toBeGreaterThan(DEFAULT_RULES.entryWindowSeconds);
  });
});

describe("pair ordering", () => {
  it("puts major pairs first, then the rest alphabetically", () => {
    expect(sortMajorsFirst(["AED/ARS", "GBP/USD", "ZAR/JPY", "EUR/USD", "AUD/USD"])).toEqual(["EUR/USD", "GBP/USD", "AUD/USD", "AED/ARS", "ZAR/JPY"]);
  });
});
