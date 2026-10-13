import type { RuleConfig } from "./rules";

/**
 * Two rule presets.
 * STRICT — every default threshold (fewest signals).
 * NORMAL — looser agreement and level filters, tolerates up to 3 quiet minutes
 *          without ticks, and keeps the signal actionable for 20 s after the candle
 *          closes (feeds can publish a finished minute a few seconds late).
 * Both still require: verified live feed, fresh data, EMA trend agreement,
 * structure not opposing, 5-minute agreement and no exhausted RSI.
 * More signals is not the same as more accurate signals — compare both in Backtest.
 */
export type SignalMode = "STRICT" | "NORMAL";

export const MODE_OVERRIDES: Record<SignalMode, Partial<RuleConfig>> = {
  STRICT: { entryWindowSeconds: 15 },
  NORMAL: {
    minAgreement: 0.3,
    minSupportingEvidence: 3,
    levelProximityAtr: 0.25,
    minAtrPercentile: 10,
    maxMissingCandles: 3,
    entryWindowSeconds: 20,
  },
};
