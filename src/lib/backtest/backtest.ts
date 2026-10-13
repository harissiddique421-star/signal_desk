import type { RuleConfig } from "../config/rules";
import { DEFAULT_RULES } from "../config/rules";
import { evaluateSignal, type SourceInfo } from "../engine/signal";
import { summarize, type Outcome, type PerformanceReport, type TradeRecord } from "../stats/performance";
import type { Candle, Decision, MarketType } from "../types";

export interface BacktestTrade {
  signalCandleTime: number;
  decision: Exclude<Decision, "NO_TRADE">;
  /** Entry = open of the candle after the signal candle */
  entry: number;
  /** Exit = close of that same candle (1-minute expiry) */
  exit: number;
  outcome: Outcome;
  segment: "IN_SAMPLE" | "OUT_OF_SAMPLE";
}

export interface BacktestResult {
  symbol: string;
  marketType: MarketType;
  source: string;
  candlesUsed: number;
  firstCandle: number | null;
  lastCandle: number | null;
  barsEvaluated: number;
  noTradeBars: number;
  /** Top NO_TRADE reasons (label → count) */
  noTradeReasons: Record<string, number>;
  trades: BacktestTrade[];
  splitTime: number | null;
  inSample: PerformanceReport;
  outOfSample: PerformanceReport;
  overall: PerformanceReport;
  assumptions: string[];
}

export interface BacktestInput {
  candles: Candle[];
  symbol: string;
  marketType: MarketType;
  source: SourceInfo;
  payout: number;
  /** Fraction of the history (chronological) used as in-sample; the rest is out-of-sample */
  inSampleFraction?: number;
  config?: RuleConfig;
  /** Window of history handed to the engine at each step */
  window?: number;
}

/**
 * Walk forward one closed candle at a time. At step i the engine only sees
 * candles[..i] and evaluates "now" as 1 second after candle i closed, so no
 * future candle can influence the decision. The outcome is read from candle i+1.
 *
 * Rules are fixed (not fitted), so the in-sample / out-of-sample split is a
 * stability check: if you tune rules, tune on in-sample only and judge on
 * out-of-sample.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  const cfg = input.config ?? DEFAULT_RULES;
  const tfMs = cfg.timeframeSeconds * 1000;
  const window = input.window ?? Math.max(cfg.minCandles + 30, 200);
  const candles = [...input.candles].sort((a, b) => a.time - b.time);
  const frac = input.inSampleFraction ?? 0.7;
  const splitIdx = Math.floor(candles.length * frac);
  const splitTime = candles[splitIdx]?.time ?? null;
  const trades: BacktestTrade[] = [];
  const noTradeReasons: Record<string, number> = {};
  let evaluated = 0;
  let noTrade = 0;

  for (let i = cfg.minCandles - 1; i < candles.length - 1; i++) {
    const slice = candles.slice(Math.max(0, i - window + 1), i + 1);
    const now = candles[i].time + tfMs + 1000;
    const res = evaluateSignal({
      candles: slice,
      symbol: input.symbol,
      marketType: input.marketType,
      symbolSupported: true,
      source: { ...input.source, verified: true }, // evaluate the rules themselves; verification is a live-only gate
      analysisKind: "LIVE_FEED",
      now,
      config: { ...cfg, requireNewsFilter: false },
    });
    evaluated++;
    const next = candles[i + 1];
    if (res.decision === "NO_TRADE" || next.time !== candles[i].time + tfMs) {
      noTrade++;
      const key = res.decision === "NO_TRADE" ? (res.checks.find((c) => !c.passed)?.label ?? "No direction") : "Next candle missing";
      noTradeReasons[key] = (noTradeReasons[key] ?? 0) + 1;
      continue;
    }
    const outcome: Outcome =
      next.close === next.open ? "TIE" : res.decision === "CALL" ? (next.close > next.open ? "WIN" : "LOSS") : next.close < next.open ? "WIN" : "LOSS";
    trades.push({
      signalCandleTime: candles[i].time,
      decision: res.decision,
      entry: next.open,
      exit: next.close,
      outcome,
      segment: i < splitIdx ? "IN_SAMPLE" : "OUT_OF_SAMPLE",
    });
  }

  const toRec = (t: BacktestTrade): TradeRecord => ({ time: t.signalCandleTime, outcome: t.outcome });
  return {
    symbol: input.symbol,
    marketType: input.marketType,
    source: input.source.name,
    candlesUsed: candles.length,
    firstCandle: candles[0]?.time ?? null,
    lastCandle: candles[candles.length - 1]?.time ?? null,
    barsEvaluated: evaluated,
    noTradeBars: noTrade,
    noTradeReasons,
    trades,
    splitTime,
    inSample: summarize(trades.filter((t) => t.segment === "IN_SAMPLE").map(toRec), input.payout),
    outOfSample: summarize(trades.filter((t) => t.segment === "OUT_OF_SAMPLE").map(toRec), input.payout),
    overall: summarize(trades.map(toRec), input.payout),
    assumptions: [
      "Entry at the OPEN of the candle after the signal candle; expiry at that candle's CLOSE (1 minute).",
      "Broker quotes, spreads and execution delay are not modelled; real fills differ from feed candles.",
      `Payout assumed ${(input.payout * 100).toFixed(0)}% on wins, full stake lost on losses, stake returned on ties.`,
      `Chronological split: first ${(frac * 100).toFixed(0)}% in-sample, remaining out-of-sample.`,
      "News filter not applied in backtests (no historical calendar configured).",
    ],
  };
}
