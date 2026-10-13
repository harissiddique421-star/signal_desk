import { z } from "zod";

/**
 * Every threshold the engine uses lives here so the rules stay transparent and
 * configurable. Nothing is learned or fitted from data.
 */
export const RuleConfigSchema = z.object({
  version: z.string().default("rules-v1"),
  timeframeSeconds: z.literal(60).default(60),
  expirySeconds: z.literal(60).default(60),

  // Data quality gates
  minCandles: z.number().int().min(60).max(1000).default(120),
  gapLookback: z.number().int().min(10).max(500).default(60),
  /** Max age of the last closed candle's CLOSE time, in seconds */
  maxStalenessSeconds: z.number().int().min(5).max(600).default(75),
  /** A signal is only actionable this many seconds into the next candle */
  entryWindowSeconds: z.number().int().min(1).max(30).default(10),

  // Indicators
  emaFast: z.number().int().min(2).max(100).default(9),
  emaSlow: z.number().int().min(3).max(200).default(21),
  emaTrend: z.number().int().min(5).max(400).default(50),
  rsiPeriod: z.number().int().min(2).max(100).default(14),
  rsiOverbought: z.number().min(50).max(100).default(70),
  rsiOversold: z.number().min(0).max(50).default(30),
  macdFast: z.number().int().min(2).max(100).default(12),
  macdSlow: z.number().int().min(3).max(200).default(26),
  macdSignal: z.number().int().min(2).max(100).default(9),
  bbPeriod: z.number().int().min(5).max(200).default(20),
  bbStdDev: z.number().min(0.5).max(5).default(2),
  atrPeriod: z.number().int().min(2).max(100).default(14),

  // Volatility filter: ATR percentile within the recent window
  volatilityWindow: z.number().int().min(30).max(1000).default(100),
  minAtrPercentile: z.number().min(0).max(100).default(20),
  maxAtrPercentile: z.number().min(0).max(100).default(95),
  /** Last candle range larger than this many ATRs = shock candle */
  shockCandleAtr: z.number().min(1).max(10).default(2.5),

  // Structure and levels
  swingStrength: z.number().int().min(1).max(10).default(2),
  levelLookback: z.number().int().min(20).max(500).default(90),
  /** Swing points within this many ATRs merge into one zone */
  levelMergeAtr: z.number().min(0.1).max(3).default(0.5),
  /** Price within this many ATRs of an opposing zone blocks the trade */
  levelProximityAtr: z.number().min(0.05).max(3).default(0.5),

  // Multi-timeframe (resampled from 1m candles)
  mtfMinutes: z.number().int().min(2).max(60).default(5),
  requireMtfAgreement: z.boolean().default(true),

  // Decision
  /** Minimum |agreementScore| (0..1) */
  minAgreement: z.number().min(0).max(1).default(0.45),
  /** Minimum count of non-neutral evidence items supporting the direction */
  minSupportingEvidence: z.number().int().min(1).max(20).default(4),
  /** Block the trade when no verified news/economic calendar is configured */
  requireNewsFilter: z.boolean().default(false),
});

export type RuleConfig = z.infer<typeof RuleConfigSchema>;

export const DEFAULT_RULES: RuleConfig = RuleConfigSchema.parse({});

/** Partial overrides accepted from the API (validated, then merged). */
export const RuleOverridesSchema = RuleConfigSchema.partial().strict();
