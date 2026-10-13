import type { Candle } from "../types";

export interface Anatomy {
  range: number;
  body: number;
  upperWick: number;
  lowerWick: number;
  /** body / range, 0..1 (0 when range is 0) */
  bodyRatio: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  bullish: boolean;
  bearish: boolean;
}

export function anatomy(c: Candle): Anatomy {
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const r = range > 0 ? range : 1;
  return {
    range,
    body,
    upperWick,
    lowerWick,
    bodyRatio: range > 0 ? body / r : 0,
    upperWickRatio: range > 0 ? upperWick / r : 0,
    lowerWickRatio: range > 0 ? lowerWick / r : 0,
    bullish: c.close > c.open,
    bearish: c.close < c.open,
  };
}

export type PatternName =
  | "BULLISH_ENGULFING"
  | "BEARISH_ENGULFING"
  | "HAMMER"
  | "SHOOTING_STAR"
  | "DOJI"
  | "BULLISH_MARUBOZU"
  | "BEARISH_MARUBOZU"
  | "INSIDE_BAR"
  | "THREE_WHITE_SOLDIERS"
  | "THREE_BLACK_CROWS";

export interface PatternHit {
  name: PatternName;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
}

/**
 * Detect patterns that complete on the LAST candle of the array.
 * Thresholds are deliberately conventional and documented inline.
 */
export function detectPatterns(candles: Candle[]): PatternHit[] {
  const hits: PatternHit[] = [];
  const n = candles.length;
  if (n === 0) return hits;
  const c = candles[n - 1];
  const a = anatomy(c);
  if (a.range === 0) return [{ name: "DOJI", direction: "NEUTRAL" }];

  // Doji: body <= 10% of range
  if (a.bodyRatio <= 0.1) hits.push({ name: "DOJI", direction: "NEUTRAL" });

  // Marubozu: body >= 90% of range
  if (a.bodyRatio >= 0.9) hits.push({ name: a.bullish ? "BULLISH_MARUBOZU" : "BEARISH_MARUBOZU", direction: a.bullish ? "BULLISH" : "BEARISH" });

  // Hammer: small body in upper third, lower wick >= 2x body, small upper wick
  if (a.body > 0 && a.lowerWick >= 2 * a.body && a.upperWickRatio <= 0.15 && a.bodyRatio <= 0.35) {
    hits.push({ name: "HAMMER", direction: "BULLISH" });
  }
  // Shooting star: mirror of hammer
  if (a.body > 0 && a.upperWick >= 2 * a.body && a.lowerWickRatio <= 0.15 && a.bodyRatio <= 0.35) {
    hits.push({ name: "SHOOTING_STAR", direction: "BEARISH" });
  }

  if (n >= 2) {
    const p = candles[n - 2];
    const pa = anatomy(p);
    // Engulfing: opposite colour, current body fully covers previous body
    if (pa.bearish && a.bullish && c.open <= p.close && c.close >= p.open && a.body > pa.body) {
      hits.push({ name: "BULLISH_ENGULFING", direction: "BULLISH" });
    }
    if (pa.bullish && a.bearish && c.open >= p.close && c.close <= p.open && a.body > pa.body) {
      hits.push({ name: "BEARISH_ENGULFING", direction: "BEARISH" });
    }
    if (c.high < p.high && c.low > p.low) hits.push({ name: "INSIDE_BAR", direction: "NEUTRAL" });
  }

  if (n >= 3) {
    const last3 = candles.slice(-3);
    const an = last3.map(anatomy);
    const rising = last3.every((x, i) => i === 0 || x.close > last3[i - 1].close);
    const falling = last3.every((x, i) => i === 0 || x.close < last3[i - 1].close);
    if (an.every((x) => x.bullish && x.bodyRatio >= 0.5) && rising) hits.push({ name: "THREE_WHITE_SOLDIERS", direction: "BULLISH" });
    if (an.every((x) => x.bearish && x.bodyRatio >= 0.5) && falling) hits.push({ name: "THREE_BLACK_CROWS", direction: "BEARISH" });
  }
  return hits;
}
