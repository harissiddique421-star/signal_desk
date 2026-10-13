import type { Candle } from "../types";
import type { Outcome } from "./performance";

export interface Resolution {
  status: "PENDING" | "RESOLVED" | "UNAVAILABLE";
  outcome?: Exclude<Outcome, "UNRESOLVED">;
  entry?: number;
  exit?: number;
  detail: string;
}

/**
 * Decide a 1-minute signal's result from feed candles, using the same rule as
 * the backtest: entry = OPEN of the candle after the signal candle, expiry =
 * CLOSE of that candle. Broker quotes can differ from the feed, so this is a
 * feed-based result, not the broker's settlement.
 */
export function resolveSignal(
  candles: Candle[],
  signalCandleTime: number,
  decision: "CALL" | "PUT",
  now: number,
  tfMs = 60_000,
): Resolution {
  const target = signalCandleTime + tfMs;
  if (now < target + tfMs) return { status: "PENDING", detail: "Trade candle has not closed yet" };
  const c = candles.find((x) => x.time === target);
  if (!c) {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const last = sorted[sorted.length - 1];
    const first = sorted[0];
    if (!last || last.time < target) return { status: "PENDING", detail: "Feed has not published the trade candle yet" };
    if (first.time > target) return { status: "UNAVAILABLE", detail: "Trade candle is older than the data fetched" };
    return { status: "UNAVAILABLE", detail: "Feed has no candle for that minute" };
  }
  const outcome: Resolution["outcome"] =
    c.close === c.open ? "TIE" : decision === "CALL" ? (c.close > c.open ? "WIN" : "LOSS") : c.close < c.open ? "WIN" : "LOSS";
  return { status: "RESOLVED", outcome, entry: c.open, exit: c.close, detail: "Resolved from feed candle" };
}
