import type { RuleConfig } from "./rules";

/**
 * Rule presets.
 *
 * V4     — DEMO ONLY: stricter exhaustion fade, not proven.
 * V2     — FADE_V2 exhaustion-fade strategy; historical results do not establish live profitability.
 * STRICT — original TREND_V1 rules.
 * NORMAL — TREND_V1 with looser agreement/level filters.
 * FAST   — EXPERIMENTAL TREND_V1 confluence mode. More permissive filters may produce more setups,
 *          but it is not validated or represented as profitable. Use for demo forward testing only.
 * QQE    — EXPERIMENTAL QQE flip / support-resistance rejection / candle-run momentum on the
 *          closed candle (non-repainting). Built from public indicator definitions; demo only.
 */
export type SignalMode = "V4" | "V2" | "STRICT" | "NORMAL" | "FAST" | "QQE";

export const SIGNAL_MODES: SignalMode[] = ["V4", "V2", "STRICT", "NORMAL", "FAST", "QQE"];

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
  FAST: {
    version: "rules-fast-confluence-experimental",
    strategy: "TREND_V1",
    minAgreement: 0.2,
    minSupportingEvidence: 2,
    levelProximityAtr: 0.15,
    minAtrPercentile: 0,
    maxAtrPercentile: 100,
    shockCandleAtr: 5,
    // Quiet minutes with no ticks are common on the free feed; 2 blocked FAST most of the day.
    maxMissingCandles: 10,
    requireMtfAgreement: false,
    entryWindowSeconds: 15,
  },
  QQE: {
    version: "rules-qqe-sr-v1",
    strategy: "QQE_SR",
    // Same feed tolerance as FAST: quiet missing minutes and a one-candle-late feed are OK.
    maxMissingCandles: 10,
    requireMtfAgreement: false,
    levelProximityAtr: 0.2,
    entryWindowSeconds: 15,
  },
};

export const MODE_LABEL: Record<SignalMode, string> = {
  V4: "v4 Demo (forward test)",
  V2: "v2 Fade (2026 mein haar raha)",
  STRICT: "v1 Strict (old)",
  NORMAL: "v1 Normal (old)",
  FAST: "Fast Confluence (experimental)",
  QQE: "QQE + S/R (experimental)",
};
