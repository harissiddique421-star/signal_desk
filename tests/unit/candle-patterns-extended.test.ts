import { describe, expect, it } from "vitest";
import { detectPatterns } from "@/lib/analysis/candles";
import type { Candle } from "@/lib/types";

const k = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close });
const T = Date.UTC(2026, 9, 14, 10, 0, 0);
const mirror = (cs: Candle[]): Candle[] => {
  const P = 2 * cs[0].close;
  return cs.map((c) => ({ ...c, open: P - c.open, close: P - c.close, high: P - c.low, low: P - c.high }));
};
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
