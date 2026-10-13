/**
 * Technical indicators. Each function returns an array aligned to the input
 * (same length); positions without enough history are `null`.
 * Every value at index i depends only on inputs 0..i (no look-ahead).
 */
import type { Candle } from "../types";

export type Series = (number | null)[];

export function sma(values: number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI with Wilder smoothing (the original definition). */
export function rsi(values: number[], period = 14): Series {
  assertPeriod(period);
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  if (fast >= slow) throw new Error("MACD fast period must be shorter than slow period");
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null));
  const firstIdx = line.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  if (firstIdx >= 0) {
    const compact = line.slice(firstIdx) as number[];
    const sig = ema(compact, signalPeriod);
    sig.forEach((v, j) => (signal[firstIdx + j] = v));
  }
  const histogram: Series = line.map((m, i) => (m !== null && signal[i] !== null ? m - (signal[i] as number) : null));
  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  middle: Series;
  upper: Series;
  lower: Series;
  /** (upper - lower) / middle */
  bandwidth: Series;
  /** (close - lower) / (upper - lower) */
  percentB: Series;
}

/** Bollinger Bands using population standard deviation (the conventional choice). */
export function bollinger(values: number[], period = 20, mult = 2): BollingerResult {
  assertPeriod(period);
  const middle = sma(values, period);
  const n = values.length;
  const upper: Series = new Array(n).fill(null);
  const lower: Series = new Array(n).fill(null);
  const bandwidth: Series = new Array(n).fill(null);
  const percentB: Series = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const m = middle[i] as number;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    bandwidth[i] = m !== 0 ? ((upper[i] as number) - (lower[i] as number)) / m : null;
    const w = (upper[i] as number) - (lower[i] as number);
    percentB[i] = w > 0 ? (values[i] - (lower[i] as number)) / w : 0.5;
  }
  return { middle, upper, lower, bandwidth, percentB };
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

/** ATR with Wilder smoothing, seeded by the simple mean of the first `period` true ranges. */
export function atr(candles: Candle[], period = 14): Series {
  assertPeriod(period);
  const tr = trueRange(candles);
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Percentile rank (0-100) of `value` within `sample`. */
export function percentileRank(sample: number[], value: number): number {
  if (!sample.length) return NaN;
  let below = 0;
  let equal = 0;
  for (const s of sample) {
    if (s < value) below++;
    else if (s === value) equal++;
  }
  return ((below + 0.5 * equal) / sample.length) * 100;
}

export function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

function assertPeriod(p: number) {
  if (!Number.isInteger(p) || p < 1) throw new Error(`Invalid period: ${p}`);
}
