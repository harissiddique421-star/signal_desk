import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";
import { MODE_OVERRIDES, SIGNAL_MODES } from "@/lib/config/presets";
import { EMPTY_FEED_STATS, lastAttemptOffsetMs, msUntilFirstScan, recordFeedOutcome, SCAN_LATENCY_BUDGET_MS } from "@/lib/client/scan-timing";

describe("scan timing (regression: retries landed after the v2 entry window)", () => {
  for (const m of SIGNAL_MODES) {
    it(`${m}: the last scan attempt plus network time ends inside the entry window`, () => {
      const cfg = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES[m] });
      expect(lastAttemptOffsetMs() + SCAN_LATENCY_BUDGET_MS).toBeLessThanOrEqual(cfg.entryWindowSeconds * 1000);
    });
  }
  it("first scan is a few seconds after the next candle close", () => {
    expect(msUntilFirstScan(Date.UTC(2026, 0, 1, 10, 0, 59, 0))).toBe(1000 + 3000);
    expect(msUntilFirstScan(Date.UTC(2026, 0, 1, 10, 0, 0, 0))).toBe(60_000 + 3000);
  });
  it("counts on which attempt the feed had the finished candle", () => {
    let s = recordFeedOutcome(EMPTY_FEED_STATS, 1);
    s = recordFeedOutcome(s, 3);
    s = recordFeedOutcome(s, null);
    expect(s).toEqual({ attempt1: 1, attempt2: 0, attempt3: 1, missed: 1 });
  });
});
