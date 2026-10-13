import type { Candle } from "../types";

export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: "HIGH" | "LOW";
}

/**
 * Fractal swing points: a swing high has `strength` lower highs on each side.
 * A swing at index i is only CONFIRMED once `strength` later candles exist,
 * so the last `strength` candles can never be swings (prevents look-ahead).
 */
export function findSwings(candles: Candle[], strength = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (!(c.high > candles[i - k].high && c.high >= candles[i + k].high)) isHigh = false;
      if (!(c.low < candles[i - k].low && c.low <= candles[i + k].low)) isLow = false;
    }
    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, kind: "HIGH" });
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, kind: "LOW" });
  }
  return swings;
}

export type StructureState = "UPTREND" | "DOWNTREND" | "RANGE" | "UNCLEAR";

export interface StructureReport {
  state: StructureState;
  lastHighs: number[];
  lastLows: number[];
  detail: string;
}

/** Classify structure from the last two confirmed swing highs and lows. */
export function marketStructure(swings: Swing[]): StructureReport {
  const highs = swings.filter((s) => s.kind === "HIGH").slice(-2).map((s) => s.price);
  const lows = swings.filter((s) => s.kind === "LOW").slice(-2).map((s) => s.price);
  if (highs.length < 2 || lows.length < 2) {
    return { state: "UNCLEAR", lastHighs: highs, lastLows: lows, detail: "Not enough confirmed swings" };
  }
  const hh = highs[1] > highs[0];
  const hl = lows[1] > lows[0];
  const lh = highs[1] < highs[0];
  const ll = lows[1] < lows[0];
  if (hh && hl) return { state: "UPTREND", lastHighs: highs, lastLows: lows, detail: "Higher high + higher low" };
  if (lh && ll) return { state: "DOWNTREND", lastHighs: highs, lastLows: lows, detail: "Lower high + lower low" };
  if ((lh && hl) || (hh && ll)) return { state: "RANGE", lastHighs: highs, lastLows: lows, detail: "Mixed swings (contracting or expanding range)" };
  return { state: "UNCLEAR", lastHighs: highs, lastLows: lows, detail: "Equal swings" };
}

export interface Zone {
  kind: "SUPPORT" | "RESISTANCE";
  low: number;
  high: number;
  mid: number;
  touches: number;
  lastTouchTime: number;
}

/**
 * Cluster swing prices into zones. Swings within `mergeDistance` of each other
 * merge. A zone is support if it sits below `price`, resistance if above.
 */
export function buildZones(swings: Swing[], price: number, mergeDistance: number): Zone[] {
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: Swing[][] = [];
  for (const s of sorted) {
    const cur = clusters[clusters.length - 1];
    // Measure from the cluster's lowest price so zones cannot chain into very wide bands.
    if (cur && s.price - cur[0].price <= mergeDistance) cur.push(s);
    else clusters.push([s]);
  }
  return clusters.map((cl) => {
    const prices = cl.map((s) => s.price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const mid = (low + high) / 2;
    return {
      kind: mid < price ? ("SUPPORT" as const) : ("RESISTANCE" as const),
      low,
      high,
      mid,
      touches: cl.length,
      lastTouchTime: Math.max(...cl.map((s) => s.time)),
    };
  });
}

export function nearestZones(zones: Zone[], price: number): { support?: Zone; resistance?: Zone } {
  let support: Zone | undefined;
  let resistance: Zone | undefined;
  for (const z of zones) {
    if (z.mid < price && (!support || z.mid > support.mid)) support = z;
    if (z.mid >= price && (!resistance || z.mid < resistance.mid)) resistance = z;
  }
  return { support, resistance };
}

export type BreakoutKind =
  | "BULLISH_BREAKOUT"
  | "BEARISH_BREAKOUT"
  | "BULLISH_RETEST"
  | "BEARISH_RETEST"
  | "FALSE_BREAKOUT_UP"
  | "FALSE_BREAKOUT_DOWN";

export interface BreakoutEvent {
  kind: BreakoutKind;
  level: number;
  detail: string;
}

/**
 * Breakout / retest / false-breakout on the last closed candle relative to the
 * highest high and lowest low of the `lookback` candles BEFORE it.
 */
export function detectBreakouts(candles: Candle[], lookback = 20, retestBars = 5): BreakoutEvent[] {
  const n = candles.length;
  if (n < lookback + 2) return [];
  const events: BreakoutEvent[] = [];
  const c = candles[n - 1];
  const window = candles.slice(n - 1 - lookback, n - 1);
  const hi = Math.max(...window.map((x) => x.high));
  const lo = Math.min(...window.map((x) => x.low));

  if (c.close > hi) events.push({ kind: "BULLISH_BREAKOUT", level: hi, detail: `Closed above ${lookback}-bar high` });
  else if (c.high > hi && c.close <= hi) events.push({ kind: "FALSE_BREAKOUT_UP", level: hi, detail: `Wick above ${lookback}-bar high but closed back inside` });

  if (c.close < lo) events.push({ kind: "BEARISH_BREAKOUT", level: lo, detail: `Closed below ${lookback}-bar low` });
  else if (c.low < lo && c.close >= lo) events.push({ kind: "FALSE_BREAKOUT_DOWN", level: lo, detail: `Wick below ${lookback}-bar low but closed back inside` });

  // Retest: an earlier breakout within `retestBars`, and the last candle touched the broken level and held
  for (let b = n - 1 - retestBars; b < n - 1; b++) {
    if (b < lookback + 1) continue;
    const prior = candles.slice(b - lookback, b);
    const pHi = Math.max(...prior.map((x) => x.high));
    const pLo = Math.min(...prior.map((x) => x.low));
    if (candles[b].close > pHi && c.low <= pHi && c.close > pHi) {
      events.push({ kind: "BULLISH_RETEST", level: pHi, detail: "Broken resistance retested and held as support" });
      break;
    }
    if (candles[b].close < pLo && c.high >= pLo && c.close < pLo) {
      events.push({ kind: "BEARISH_RETEST", level: pLo, detail: "Broken support retested and held as resistance" });
      break;
    }
  }
  return events;
}

/**
 * Resample 1m candles into `minutes`-minute candles. Only COMPLETE buckets
 * (all constituent minutes present and closed) are emitted, so the higher
 * timeframe never leaks information from an unfinished bar.
 */
export function resample(candles: Candle[], minutes: number, baseMs = 60_000): Candle[] {
  const bucketMs = minutes * baseMs;
  const out: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketStart = -1;
  const flush = () => {
    if (bucket.length === minutes) {
      out.push({
        time: bucketStart,
        open: bucket[0].open,
        high: Math.max(...bucket.map((b) => b.high)),
        low: Math.min(...bucket.map((b) => b.low)),
        close: bucket[bucket.length - 1].close,
      });
    }
  };
  for (const c of candles) {
    const start = Math.floor(c.time / bucketMs) * bucketMs;
    if (start !== bucketStart) {
      flush();
      bucket = [];
      bucketStart = start;
    }
    bucket.push(c);
  }
  flush();
  return out;
}
