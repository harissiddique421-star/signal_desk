import type { RuleConfig } from "./rules";

/**
 * Rule presets.
 *
 * V2     — FADE_V2 exhaustion-fade strategy (default). The only preset whose
 *          historical out-of-sample win rate cleared break-even at an 85 % payout,
 *          and only when the entry is taken at the very start of the next candle.
 *          See docs/RESEARCH.md for every number and its limits.
 * STRICT — the original TREND_V1 rules with every default threshold.
 * NORMAL — TREND_V1 with looser agreement/level filters, up to 3 quiet minutes missing
 *          and a 20 s entry window.
 * STRICT and NORMAL are kept so a strategy version can be rolled back and compared,
 * but on 3.87 M historical minutes both lost (win rate 48–49 %, CI below 50 %).
 */
export type SignalMode = "V2" | "STRICT" | "NORMAL";

export const SIGNAL_MODES: SignalMode[] = ["V2", "STRICT", "NORMAL"];

export const MODE_OVERRIDES: Record<SignalMode, Partial<RuleConfig>> = {
  V2: {
    version: "rules-v2-fade",
    strategy: "FADE_V2",
    // Mean reversion fades within seconds (one minute late = 51.5 %), but the window must
    // cover the app's last scan attempt (11 s) plus network time — see src/lib/client/scan-timing.ts.
    entryWindowSeconds: 15,
  },
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

export const MODE_LABEL: Record<SignalMode, string> = {
  V2: "v2 Fade (tested)",
  STRICT: "v1 Strict (old)",
  NORMAL: "v1 Normal (old)",
};
