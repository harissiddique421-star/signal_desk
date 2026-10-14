import { describe, expect, it } from "vitest";
import { evaluateSignal } from "@/lib/engine/signal";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";
import { MODE_OVERRIDES } from "@/lib/config/presets";
import { detectPatterns } from "@/lib/analysis/candles";
import { generateSampleCandles } from "@/lib/providers/sample";
import type { Candle } from "@/lib/types";

const cfg = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.FAST });
const T = Date.UTC(2026, 9, 14, 10, 0, 0);
const source = { id: "t", name: "Test feed", verified: true, supportedMarketTypes: ["LIVE" as const] };
const k = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close });

/** History, then 3 strong down candles and a final candle built by `last(prevClose, R)`. */
function series(last: (prevClose: number, R: number, time: number) => Candle): Candle[] {
  const hist = generateSampleCandles("EUR/USD", T, 400).filter((c) => c.time < T);
  const R = hist.slice(-20).reduce((s, c) => s + (c.high - c.low), 0) / 20;
  const out = [...hist];
  let p = hist[hist.length - 1].close;
  for (let j = 0; j < 3; j++) {
    const o = p;
    const c = o - 1.3 * R;
    out.push(k(T + j * 60_000, o, o + 0.05 * R, c - 0.05 * R, c));
    p = c;
  }
  out.push(last(p, R, T + 180_000));
  return out;
}
const mirror = (cs: Candle[]): Candle[] => {
  const P = 2 * cs[0].close;
  return cs.map((c) => ({ ...c, open: P - c.open, close: P - c.close, high: P - c.low, low: P - c.high }));
};
const run = (candles: Candle[]) =>
  evaluateSignal({ candles, symbol: "EUR/USD", marketType: "LIVE", symbolSupported: true, source, analysisKind: "LIVE_FEED", now: T + 240_000 + 4_000, config: cfg });

const hammer = (p: number, R: number, t: number) => k(t, p - 0.1 * R, p + 0.12 * R, p - 1.3 * R, p + 0.1 * R);
const bigDown = (p: number, R: number, t: number) => k(t, p, p + 0.05 * R, p - 1.35 * R, p - 1.3 * R);

describe("FAST candle-pattern strategy", () => {
  it("CALL on a hammer after a sell-off (at the lower band / low RSI)", () => {
    const r = run(series(hammer));
    expect(r.decision).toBe("CALL");
    expect(r.evidence.find((e) => e.id === "setup.pattern")?.label).toBe("HAMMER");
    expect(r.checks.find((c) => c.id === "pattern.setup")?.passed).toBe(true);
  });

  it("PUT on the mirror image (shooting star after a rally)", () => {
    const r = run(mirror(series(hammer)));
    expect(r.decision).toBe("PUT");
    expect(r.evidence.find((e) => e.id === "setup.pattern")?.label).toBe("SHOOTING STAR");
  });

  it("WAIT when the signal candle has no reversal pattern at the extreme", () => {
    // a plain 4th down candle: trend continuation candle, but RSI is exhausted → no trade
    const r = run(series(bigDown));
    expect(r.decision).toBe("NO_TRADE");
  });

  it("only signals when a pattern passed, never from indicator votes alone", () => {
    const base = Date.UTC(2026, 9, 14, 9, 0, 4);
    let signals = 0;
    for (let m = 0; m < 300; m++) {
      const now = base + m * 60_000;
      const r = evaluateSignal({ candles: generateSampleCandles("GBP/USD", now, 400), symbol: "GBP/USD", marketType: "LIVE", symbolSupported: true, source, analysisKind: "LIVE_FEED", now, config: cfg });
      if (r.decision !== "NO_TRADE") {
        signals++;
        expect(r.checks.find((c) => c.id === "pattern.found")?.passed).toBe(true);
        expect(r.checks.find((c) => c.id === "pattern.setup")?.passed).toBe(true);
      }
    }
    expect(signals).toBeLessThan(300); // fewer than one per minute
  });
});

describe("extended candlestick patterns", () => {
  const t = (i: number) => T + i * 60_000;
  it("morning star / evening star", () => {
    const ms = [k(t(0), 1.1, 1.101, 1.0, 1.001), k(t(1), 1.0, 1.006, 0.995, 1.002), k(t(2), 1.003, 1.08, 1.002, 1.075)];
    expect(detectPatterns(ms, { extended: true }).map((p) => p.name)).toContain("MORNING_STAR");
    expect(detectPatterns(mirror(ms), { extended: true }).map((p) => p.name)).toContain("EVENING_STAR");
  });
  it("piercing line / dark cloud cover", () => {
    const pl = [k(t(0), 1.1, 1.101, 1.0, 1.002), k(t(1), 1.0, 1.07, 0.998, 1.065)];
    expect(detectPatterns(pl, { extended: true }).map((p) => p.name)).toContain("PIERCING_LINE");
    expect(detectPatterns(mirror(pl), { extended: true }).map((p) => p.name)).toContain("DARK_CLOUD_COVER");
  });
  it("tweezer bottom / top", () => {
    const tw = [k(t(0), 1.05, 1.052, 1.0, 1.01), k(t(1), 1.01, 1.04, 1.0005, 1.035)];
    expect(detectPatterns(tw, { extended: true }).map((p) => p.name)).toContain("TWEEZER_BOTTOM");
    expect(detectPatterns(mirror(tw), { extended: true }).map((p) => p.name)).toContain("TWEEZER_TOP");
  });
  it("other modes keep the original pattern set", () => {
    const ms = [k(t(0), 1.1, 1.101, 1.0, 1.001), k(t(1), 1.0, 1.006, 0.995, 1.002), k(t(2), 1.003, 1.08, 1.002, 1.075)];
    expect(detectPatterns(ms).map((p) => p.name)).not.toContain("MORNING_STAR");
  });
});
