import { describe, expect, it } from "vitest";
import history from "@/lib/research/history.json";

describe("verified history shown in the app", () => {
  it("every version reports sample size and a 95% interval that contains its win rate", () => {
    for (const v of history.versions) {
      expect(v.test.n).toBeGreaterThan(1000);
      const [lo, hi] = v.test.ci95 as [number, number];
      expect(lo).toBeLessThanOrEqual(v.test.winRate as number);
      expect(hi).toBeGreaterThanOrEqual(v.test.winRate as number);
    }
  });
  it("break-even matches the payout", () => {
    expect(history.breakEven).toBeCloseTo(1 / (1 + history.payout), 3);
  });
  it("never claims a tested win rate of 90%", () => {
    for (const v of history.versions) expect(v.test.ci95![1] as number).toBeLessThan(0.9);
  });
  it("states that OTC was not tested", () => {
    expect(history.otc).toMatch(/No OTC data/);
  });
});
