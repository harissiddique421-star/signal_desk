import { describe, expect, it } from "vitest";
import { qqe } from "@/lib/indicators";
import { evaluateSignal } from "@/lib/engine/signal";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";
import { MODE_LABEL, MODE_OVERRIDES, SIGNAL_MODES } from "@/lib/config/presets";
import { SignalModeSchema } from "@/lib/api/schemas";
import { generateSampleCandles } from "@/lib/providers/sample";
import type { Candle } from "@/lib/types";

const cfg = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.QQE });
const source = { id: "t", name: "Test feed", verified: true, supportedMarketTypes: ["LIVE" as const] };
const run = (candles: Candle[], now: number) =>
  evaluateSignal({ candles, symbol: "EUR/USD", marketType: "LIVE", symbolSupported: true, source, analysisKind: "LIVE_FEED", now, config: cfg });
const mirror = (cs: Candle[]): Candle[] => {
  const P = 2 * cs[0].close;
  return cs.map((c) => ({ ...c, open: P - c.open, close: P - c.close, high: P - c.low, low: P - c.high }));
};

describe("QQE indicator", () => {
  it("is in an up-phase on a rally and flips down after a sell-off", () => {
    const up = Array.from({ length: 120 }, (_, i) => 100 + i * 0.1 + Math.sin(i) * 0.05);
    const down = Array.from({ length: 60 }, (_, i) => up[up.length - 1] - i * 0.3);
    const q = qqe([...up, ...down]);
    expect(q.trend[115]).toBe(1);
    expect(q.trend[q.trend.length - 1]).toBe(-1);
    expect(q.rsiMa[115]! > 50).toBe(true);
  });
  it("has no look-ahead: earlier values do not change when data is appended", () => {
    const v = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) + i * 0.01);
    const a = qqe(v.slice(0, 150));
    const b = qqe(v);
    expect(b.trail.slice(0, 150)).toEqual(a.trail);
  });
});

describe("QQE + S/R mode", () => {
  it("is a selectable, API-valid mode", () => {
    expect(SIGNAL_MODES).toContain("QQE");
    expect(SignalModeSchema.parse("QQE")).toBe("QQE");
    expect(MODE_LABEL.QQE).toContain("experimental");
  });

  it("only signals with an entry, (almost) symmetric for up/down, and fewer than one per minute", () => {
    const base = Date.UTC(2026, 9, 14, 6, 0, 4);
    let signals = 0;
    let calls = 0;
    let mismatches = 0;
    for (const sym of ["EUR/USD", "GBP/USD"]) {
      for (let m = 0; m < 400; m++) {
        const now = base + m * 60_000;
        const c = generateSampleCandles(sym, now, 400);
        const r = run(c, now);
        const rm = run(mirror(c), now);
        const flip = r.decision === "CALL" ? "PUT" : r.decision === "PUT" ? "CALL" : "NO_TRADE";
        // zone clustering starts from the lowest swing, so S/R zones are not exactly mirror-symmetric
        if (rm.decision !== flip) mismatches++;
        if (r.decision !== "NO_TRADE") {
          signals++;
          if (r.decision === "CALL") calls++;
          expect(r.checks.find((x) => x.id === "qqe.entry")?.passed).toBe(true);
          expect(r.evidence.some((e) => e.module === "QQE + S/R")).toBe(true);
        }
      }
    }
    expect(mismatches).toBeLessThan(0.12 * 800);
    expect(calls / signals).toBeGreaterThan(0.35);
    expect(calls / signals).toBeLessThan(0.65);
    expect(signals).toBeGreaterThan(0);
    expect(signals).toBeLessThan(800);
    expect(calls).toBeGreaterThan(0);
  });
});
