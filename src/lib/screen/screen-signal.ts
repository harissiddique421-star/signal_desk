import { detectPatterns, PATTERN_UR, type PatternHit } from "../analysis/candles";
import { ema } from "../indicators";
import type { Candle } from "../types";
import type { ScreenCandle } from "./read-chart";

export interface ScreenSignal {
  direction: "UP" | "DOWN";
  strength: "STRONG" | "WEAK";
  /** positive = up, negative = down */
  score: number;
  /** Roman-Urdu reasons, most important first */
  reasons: string[];
  patterns: string[];
  candles: number;
}

export const MIN_SCREEN_CANDLES = 6;

/**
 * A direction for the NEXT candle from candles read off the screen. Always answers UP or
 * DOWN (the user asked for a signal on every scan); `strength` says how much agreed.
 * Votes: candlestick pattern on the last candles (±2), EMA 5/13 trend (±1.5), colour of
 * the last 3 candles (±0.5 each), and where price sits in the visible range (±0.75).
 * This is an estimate from a picture, not a validated strategy.
 */
export function screenSignal(read: ScreenCandle[]): ScreenSignal | null {
  if (read.length < MIN_SCREEN_CANDLES) return null;
  const candles: Candle[] = read.map((c, i) => ({ time: i * 60_000, open: c.open, high: c.high, low: c.low, close: c.close }));
  const reasons: { w: number; text: string }[] = [];
  let score = 0;

  // 1. candlestick patterns on the last candles
  const hits = detectPatterns(candles.slice(-3), { extended: true }).filter((p) => p.direction !== "NEUTRAL");
  const bull = hits.filter((p) => p.direction === "BULLISH");
  const bear = hits.filter((p) => p.direction === "BEARISH");
  const named = (p: PatternHit) => p.name.replaceAll("_", " ").toLowerCase();
  if (bull.length && !bear.length) {
    score += 2;
    reasons.push({ w: 2, text: `Pattern: ${named(bull[0])} — ${PATTERN_UR[bull[0].name] ?? "upar ka ishara."}` });
  } else if (bear.length && !bull.length) {
    score -= 2;
    reasons.push({ w: 2, text: `Pattern: ${named(bear[0])} — ${PATTERN_UR[bear[0].name] ?? "neeche ka ishara."}` });
  } else if (bull.length && bear.length) {
    reasons.push({ w: 0.1, text: "Patterns aapas mein ulte hain — in ka vote nahin gina." });
  }

  // 2. trend: EMA 5 vs EMA 13 (or the slope of the last 5 closes on a short chart)
  const closes = candles.map((c) => c.close);
  const i = closes.length - 1;
  let trend = 0;
  if (closes.length >= 13) {
    const f = ema(closes, 5)[i] as number;
    const s = ema(closes, 13)[i] as number;
    trend = f > s ? 1 : f < s ? -1 : 0;
  } else {
    const d = closes[i] - closes[Math.max(0, i - 4)];
    trend = d > 0 ? 1 : d < 0 ? -1 : 0;
  }
  if (trend) {
    score += 1.5 * trend;
    reasons.push({ w: 1.5, text: trend > 0 ? "Trend upar ka hai (tez average dheemi se upar)." : "Trend neeche ka hai (tez average dheemi se neeche)." });
  }

  // 3. momentum: colour of the last 3 candles
  const last3 = candles.slice(-3);
  const greens = last3.filter((c) => c.close > c.open).length;
  const reds = last3.filter((c) => c.close < c.open).length;
  const mom = (greens - reds) * 0.5;
  if (mom) {
    score += mom;
    reasons.push({ w: Math.abs(mom), text: `Aakhri 3 candles: ${greens} hari, ${reds} laal.` });
  }

  // 4. position in the visible range: at the very top/bottom a pullback is more likely
  const win = candles.slice(-30);
  const hi = Math.max(...win.map((c) => c.high));
  const lo = Math.min(...win.map((c) => c.low));
  const pos = hi > lo ? (closes[i] - lo) / (hi - lo) : 0.5;
  if (pos >= 0.9) {
    score -= 0.75;
    reasons.push({ w: 0.75, text: "Price screen ki range ke bilkul upar hai — wapas aane ka khatra." });
  } else if (pos <= 0.1) {
    score += 0.75;
    reasons.push({ w: 0.75, text: "Price screen ki range ke bilkul neeche hai — wapas uthne ka chance." });
  }

  const lastC = candles[i];
  const direction: "UP" | "DOWN" = score > 0 ? "UP" : score < 0 ? "DOWN" : lastC.close >= lastC.open ? "UP" : "DOWN";
  if (score === 0) reasons.push({ w: 0, text: "Votes barabar the — aakhri candle ka rang dekha gaya." });
  return {
    direction,
    strength: Math.abs(score) >= 2.5 ? "STRONG" : "WEAK",
    score: Math.round(score * 100) / 100,
    reasons: reasons.sort((a, b) => b.w - a.w).map((r) => r.text),
    patterns: hits.map(named),
    candles: read.length,
  };
}
