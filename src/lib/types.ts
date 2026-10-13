/**
 * Core domain types for Signal Desk.
 * All timestamps are UTC epoch milliseconds unless the name says otherwise.
 */

/** A single OHLC candle. `time` is the candle OPEN time (UTC ms). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * LIVE = regular exchange / interbank market quotes.
 * OTC  = broker-generated over-the-counter quotes (e.g. Quotex "OTC" pairs).
 * These are never mixed: a regular FX feed does NOT represent broker OTC prices.
 */
export type MarketType = "LIVE" | "OTC";

export type Decision = "CALL" | "PUT" | "NO_TRADE";

/** Where the candles behind an analysis came from. */
export type AnalysisKind = "LIVE_FEED" | "SAMPLE" | "SCREENSHOT";

export type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface Evidence {
  /** Stable machine id, e.g. "trend.ema" */
  id: string;
  /** Module group shown in the UI */
  module: string;
  label: string;
  direction: Direction;
  /** Weight applied when direction is not NEUTRAL */
  weight: number;
  /** English technical detail */
  detail: string;
  /** Roman Urdu explanation */
  detailUr?: string;
}

export interface Check {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface SignalResult {
  /** The tradable decision. Always NO_TRADE unless every gate passes on a verified live feed. */
  decision: Decision;
  /**
   * What the rule engine alone concluded, before the source-verification gate.
   * Useful for testing on sample data; never shown as a tradable signal.
   */
  engineDecision: Decision;
  analysisKind: AnalysisKind;
  symbol: string;
  displaySymbol: string;
  marketType: MarketType;
  source: string;
  sourceVerified: boolean;
  /** Server clock time the analysis ran (UTC ms) */
  analyzedAt: number;
  /** Open time of the last CLOSED candle used (UTC ms) */
  signalCandleTime: number | null;
  /** Close of the last closed candle — a reference only, not a quoted broker price */
  entryReference: number | null;
  /** Earliest intended entry: open of the next candle (UTC ms) */
  entryWindowStart: number | null;
  /** After this time the signal is considered stale (UTC ms) */
  entryWindowEnd: number | null;
  expirySeconds: number;
  checks: Check[];
  evidence: Evidence[];
  /** Exact reasons when decision is NO_TRADE */
  reasons: string[];
  warnings: string[];
  /** Weighted bullish minus bearish evidence, normalised to -1..1. NOT a probability. */
  agreementScore: number;
  bullishWeight: number;
  bearishWeight: number;
  ruleVersion: string;
}

export interface ProviderSymbol {
  symbol: string;
  displaySymbol: string;
  marketType: MarketType;
  base?: string;
  quote?: string;
}
