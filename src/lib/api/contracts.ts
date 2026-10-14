/** Shapes shared by API routes and the client. Type-only; safe to import anywhere. */
import type { BacktestResult } from "../backtest/backtest";
import type { ShadowDecision } from "../engine/shadow";
import type { ProviderHealth } from "../providers/types";
import type { PerformanceReport, Outcome } from "../stats/performance";
import type { Candle, MarketType, ProviderSymbol, SignalResult } from "../types";

export interface ChartPayload {
  candles: Candle[];
  emaFast: (number | null)[];
  emaSlow: (number | null)[];
  bbUpper: (number | null)[];
  bbLower: (number | null)[];
  zones: { kind: "SUPPORT" | "RESISTANCE"; low: number; high: number; touches: number }[];
}

export interface AnalyzeResponse {
  result: SignalResult;
  chart: ChartPayload | null;
  provider: { id: string; name: string; verified: boolean; latencyMs: number };
  /** Shadow mode: what the comparison versions would have decided on the same candles. Not signals. */
  shadow?: ShadowDecision[];
}

export interface HealthResponse {
  serverTime: number;
  liveDataAvailable: boolean;
  otcDataAvailable: boolean;
  otcNote: string;
  newsFilterAvailable: boolean;
  screenshotInterpretation: "NOT_IMPLEMENTED" | "AVAILABLE";
  accountsEnabled: boolean;
  providers: ProviderHealth[];
}

export interface SymbolsResponse {
  provider: string;
  marketType: MarketType;
  verified: boolean;
  symbols: ProviderSymbol[];
}

export interface BacktestResponse {
  synthetic: boolean;
  notice: string;
  result: BacktestResult;
}

export interface ScreenshotResponse {
  accepted: boolean;
  analysisKind: "SCREENSHOT";
  marketType: MarketType | null;
  image: { type: string; bytes: number; width: number; height: number };
  stored: false;
  interpretation: "NOT_IMPLEMENTED";
  decision: "NO_TRADE";
  message: string;
  messageUr: string;
}

export interface MeResponse {
  accountsEnabled: boolean;
  user: { email: string | null } | null;
}

/** Row shape returned by /api/journal (snake_case from Postgres). */
export interface JournalRow {
  id: string;
  created_at: string;
  source: string;
  pair: string;
  market_type: MarketType;
  analysis_kind: "LIVE_FEED" | "SAMPLE" | "SCREENSHOT";
  decision: "CALL" | "PUT" | "NO_TRADE";
  engine_decision: "CALL" | "PUT" | "NO_TRADE";
  signal_candle_time: string | null;
  entry_reference: number | null;
  agreement_score: number;
  rule_version: string;
  outcome: Outcome;
  entry_price: number | null;
  exit_price: number | null;
  payout_percent: number | null;
  entry_delay_seconds: number | null;
  result_source: "UNVERIFIED" | "BROKER_MANUAL" | "FEED_ESTIMATE";
  notes: string | null;
}

export interface JournalListResponse {
  records: JournalRow[];
  summary: PerformanceReport;
}

export interface ApiError {
  error: string;
  issues?: { path: string; message: string }[];
  requestId?: string;
}
