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
  | "THREE_BLACK_CROWS"
  // extended set (FAST pattern strategy only)
  | "MORNING_STAR"
  | "EVENING_STAR"
  | "TWEEZER_BOTTOM"
  | "TWEEZER_TOP"
  | "PIERCING_LINE"
  | "DARK_CLOUD_COVER";

/** Patterns that signal a turn; they need a location (support/resistance, band or RSI extreme). */
export const REVERSAL_PATTERNS: ReadonlySet<PatternName> = new Set<PatternName>([
  "BULLISH_ENGULFING",
  "BEARISH_ENGULFING",
  "HAMMER",
  "SHOOTING_STAR",
  "MORNING_STAR",
  "EVENING_STAR",
  "TWEEZER_BOTTOM",
  "TWEEZER_TOP",
  "PIERCING_LINE",
  "DARK_CLOUD_COVER",
]);

/** Patterns that signal the move continuing; they need the trend on their side. */
export const CONTINUATION_PATTERNS: ReadonlySet<PatternName> = new Set<PatternName>([
  "BULLISH_MARUBOZU",
  "BEARISH_MARUBOZU",
  "THREE_WHITE_SOLDIERS",
  "THREE_BLACK_CROWS",
]);

/** Roman-Urdu one-liners shown under a FAST pattern signal. */
export const PATTERN_UR: Partial<Record<PatternName, string>> = {
  BULLISH_ENGULFING: "Hari candle ne pichli laal candle ko poora dhak liya — kharidar haavi.",
  BEARISH_ENGULFING: "Laal candle ne pichli hari candle ko poora dhak liya — bechne wale haavi.",
  HAMMER: "Lambi neeche wali wick — neeche se khareedari aayi (hammer).",
  SHOOTING_STAR: "Lambi upar wali wick — upar se bikwali aayi (shooting star).",
  MORNING_STAR: "Laal, choti, phir mazboot hari candle — neeche se palatne ka nishan.",
  EVENING_STAR: "Hari, choti, phir mazboot laal candle — upar se palatne ka nishan.",
  TWEEZER_BOTTOM: "Do candles ka low barabar — neeche wala level do baar bacha.",
  TWEEZER_TOP: "Do candles ka high barabar — upar wala level do baar ruka.",
  PIERCING_LINE: "Hari candle laal candle ke aadhe se upar band hui — khareedari wapas aayi.",
  DARK_CLOUD_COVER: "Laal candle hari candle ke aadhe se neeche band hui — bikwali wapas aayi.",
  BULLISH_MARUBOZU: "Poori body wali hari candle — upar ka zor saaf.",
  BEARISH_MARUBOZU: "Poori body wali laal candle — neeche ka zor saaf.",
  THREE_WHITE_SOLDIERS: "Lagatar teen mazboot hari candles — upar ka rujhan jaari.",
  THREE_BLACK_CROWS: "Lagatar teen mazboot laal candles — neeche ka rujhan jaari.",
};

export interface PatternHit {
  name: PatternName;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
}

/**
 * Detect patterns that complete on the LAST candle of the array.
 * Thresholds are deliberately conventional and documented inline.
 */
export function detectPatterns(candles: Candle[], opts: { extended?: boolean } = {}): PatternHit[] {
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
  if (opts.extended) hits.push(...detectExtended(candles));
  return hits;
}

/** Extra 2–3 candle reversal patterns, conventional definitions. */
function detectExtended(candles: Candle[]): PatternHit[] {
  const hits: PatternHit[] = [];
  const n = candles.length;
  if (n < 2) return hits;
  const c = candles[n - 1];
  const p = candles[n - 2];
  const a = anatomy(c);
  const pa = anatomy(p);
  const pMid = (p.open + p.close) / 2;

  // Tweezers: opposite colours, lows (or highs) equal within 5 % of the larger range
  const tol = 0.05 * Math.max(a.range, pa.range);
  if (tol > 0 && pa.bearish && a.bullish && Math.abs(c.low - p.low) <= tol) hits.push({ name: "TWEEZER_BOTTOM", direction: "BULLISH" });
  if (tol > 0 && pa.bullish && a.bearish && Math.abs(c.high - p.high) <= tol) hits.push({ name: "TWEEZER_TOP", direction: "BEARISH" });

  // Piercing line / dark cloud: strong prior candle, current closes past its body midpoint but not past its open
  if (pa.bearish && pa.bodyRatio >= 0.5 && a.bullish && c.open <= p.close && c.close > pMid && c.close < p.open) {
    hits.push({ name: "PIERCING_LINE", direction: "BULLISH" });
  }
  if (pa.bullish && pa.bodyRatio >= 0.5 && a.bearish && c.open >= p.close && c.close < pMid && c.close > p.open) {
    hits.push({ name: "DARK_CLOUD_COVER", direction: "BEARISH" });
  }

  // Morning / evening star: strong candle, small middle candle, strong opposite candle past the first body's midpoint
  if (n >= 3) {
    const f = candles[n - 3];
    const fa = anatomy(f);
    const m = anatomy(p);
    const fMid = (f.open + f.close) / 2;
    const smallMiddle = m.body <= 0.5 * fa.body;
    if (fa.bearish && fa.bodyRatio >= 0.5 && smallMiddle && a.bullish && a.bodyRatio >= 0.5 && c.close > fMid) hits.push({ name: "MORNING_STAR", direction: "BULLISH" });
    if (fa.bullish && fa.bodyRatio >= 0.5 && smallMiddle && a.bearish && a.bodyRatio >= 0.5 && c.close < fMid) hits.push({ name: "EVENING_STAR", direction: "BEARISH" });
  }
  return hits;
}
