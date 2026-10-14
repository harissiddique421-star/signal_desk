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
