import { describe, expect, it } from "vitest";
import { SignalModeSchema } from "@/lib/api/schemas";
import { MODE_OVERRIDES, MODE_LABEL, SIGNAL_MODES } from "@/lib/config/presets";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";

describe("experimental FAST mode", () => {
  it("is exposed as a selectable and API-valid mode", () => {
    expect(SIGNAL_MODES).toContain("FAST");
    expect(SignalModeSchema.parse("FAST")).toBe("FAST");
    expect(MODE_LABEL.FAST).toContain("experimental");
  });

  it("keeps the standard trend engine while relaxing only selected filters", () => {
    const fast = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.FAST });
    expect(fast.strategy).toBe("TREND_V1");
    expect(fast.minAgreement).toBeLessThan(DEFAULT_RULES.minAgreement);
    expect(fast.minSupportingEvidence).toBeLessThan(DEFAULT_RULES.minSupportingEvidence);
    expect(fast.requireMtfAgreement).toBe(false);
    expect(fast.entryWindowSeconds).toBe(15);
    // Data integrity / freshness and verified-provider gates are not mode overrides.
    expect(fast.minCandles).toBe(DEFAULT_RULES.minCandles);
    expect(fast.maxStalenessSeconds).toBe(DEFAULT_RULES.maxStalenessSeconds);
  });
});

import { evaluateSignal } from "@/lib/engine/signal";
import { generateSampleCandles } from "@/lib/providers/sample";
import type { Candle } from "@/lib/types";

describe("FAST mode on a slow or patchy feed", () => {
  const cfg = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.FAST });
  // Wednesday 09:30:04 UTC — 4 s after a candle closed, inside the 15 s entry window
  const now = Date.UTC(2026, 9, 14, 9, 30, 4);
  const justClosed = Date.UTC(2026, 9, 14, 9, 29, 0);
  const run = (candles: Candle[], config = cfg) =>
    evaluateSignal({
      candles,
      symbol: "EUR/USD",
      marketType: "LIVE",
      symbolSupported: true,
      source: { id: "test", name: "Test feed", verified: true, supportedMarketTypes: ["LIVE"] },
      analysisKind: "LIVE_FEED",
      now,
      config,
    });
  const full = generateSampleCandles("EUR/USD", now, 400);

  it("signals when the feed is one candle late and anchors the trade to the current minute", () => {
    const lagged = full.filter((c) => c.time < justClosed);
    const r = run(lagged);
    expect(r.checks.filter((c) => !c.passed && (c.id.startsWith("data.") || c.id === "timing.window"))).toEqual([]);
    expect(r.checks.find((c) => c.id === "data.freshness")?.passed).toBe(true);
    expect(r.signalCandleTime).toBe(justClosed);
    expect(r.entryWindowStart).toBe(justClosed + 60_000);
  });

  it("still refuses a feed that is two or more candles behind", () => {
    const stale = full.filter((c) => c.time < justClosed - 60_000);
    const r = run(stale);
    expect(r.decision).toBe("NO_TRADE");
    expect(r.checks.find((c) => c.id === "data.freshness")?.passed).toBe(false);
  });

  it("tolerates several quiet missing minutes", () => {
    const gappy = full.filter((_, i) => ![full.length - 5, full.length - 12, full.length - 20, full.length - 33].includes(i));
    const r = run(gappy);
    expect(r.checks.find((c) => c.id === "data.gaps")?.passed).toBe(true);
    expect(r.checks.filter((c) => !c.passed && (c.id.startsWith("data.") || c.id === "timing.window"))).toEqual([]);
  });

  it("does not relax freshness for the other modes", () => {
    const lagged = full.filter((c) => c.time < justClosed);
    const normal = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.NORMAL });
    expect(run(lagged, normal).checks.find((c) => c.id === "data.freshness")?.passed).toBe(false);
  });
});
