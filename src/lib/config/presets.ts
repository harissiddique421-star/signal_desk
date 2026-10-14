import type { RuleConfig } from "./rules";

/**
 * Rule presets.
 *
 * V4     — DEMO ONLY (default): stricter exhaustion fade from the 2026 search; not proven.
 * V2     — FADE_V2 exhaustion-fade strategy. On 2018–2020 history the only preset whose
 *          historical out-of-sample win rate cleared break-even at an 85 % payout,
 *          and only when the entry is taken at the very start of the next candle.
 *          See docs/RESEARCH.md for every number and its limits.
 * STRICT — the original TREND_V1 rules with every default threshold.
 * NORMAL — TREND_V1 with looser agreement/level filters, up to 3 quiet minutes missing
 *          and a 20 s entry window.
 * STRICT and NORMAL are kept so a strategy version can be rolled back and compared,
 * but on 3.87 M historical minutes both lost (win rate 48–49 %, CI below 50 %).
 */
export type SignalMode = "V4" | "V2" | "STRICT" | "NORMAL";

export const SIGNAL_MODES: SignalMode[] = ["V4", "V2", "STRICT", "NORMAL"];

export const MODE_OVERRIDES: Record<SignalMode, Partial<RuleConfig>> = {
  // DEMO ONLY. Chosen by the pre-registered search in scripts/research/search_v4.py on
  // Dukascopy 2024-08..2026-10 (docs/RESEARCH.md §12). TEST 55.8 % (52.5–59.1 %) on 860
  // trades at 90 % payout: the lower bound missed break-even (52.6 %), so it is NOT a
  // proven strategy. It exists to be forward-tested on a demo account.
  V4: {
    version: "rules-v4-fade-demo",
    strategy: "FADE_V2",
    fadePercentBOutside: 0.2,
    fadeMinRangeAtr: 3,
    fadeMinBodyRatio: 0.5,
    fadeRsiExtreme: 75,
    fadeRangeVsAtrIncludingSignal: true,
    entryWindowSeconds: 15,
  },
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
  V4: "v4 Demo (forward test)",
  V2: "v2 Fade (2026 mein haar raha)",
  STRICT: "v1 Strict (old)",
  NORMAL: "v1 Normal (old)",
};
