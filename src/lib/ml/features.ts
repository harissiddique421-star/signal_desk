import { atr, bollinger, ema, macd, rsi, trueRange } from "../indicators";
import type { Candle } from "../types";

/**
 * Decision-time features for the v3 shadow model, computed on the last CLOSED
 * candle of `candles`. A line-for-line port of scripts/research/features.py
 * (parity is unit-tested against a fixture produced by that script).
 * Returns null when there is not enough clean history.
 */
export const FEATURE_NAMES = [
  "ret1", "ret2", "ret3", "ret5", "ret10", "ret20", "ret60", "run",
  "body", "upw", "loww", "rangeAtr", "bodyAtr", "prevBody",
  "rsi14", "rsi7", "pb", "macdh", "macdhD",
  "ema9_21", "c_ema50", "ema21slope",
  "atrPct", "atrRatio", "bbwAtr",
  "distHi20", "distLo20", "pos20",
  "r5",
  "hourSin", "hourCos", "dow", "min5",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number>;

const M = 60_000;
const MIN_HISTORY = 130;

export function computeFeatures(candles: Candle[]): FeatureVector | null {
  const n = candles.length;
  if (n < MIN_HISTORY) return null;
  const i = n - 1;
  const o = candles.map((x) => x.open);
  const h = candles.map((x) => x.high);
  const l = candles.map((x) => x.low);
  const c = candles.map((x) => x.close);
  const a = atr(candles, 14);
  const at = a[i];
  const atPrev = a[i - 1];
  if (at === null || atPrev === null || !(at > 0)) return null;

  const ret = (k: number) => (c[i] - c[i - k]) / at;
  const rng = (j: number) => h[j] - l[j];
  const ratio = (num: number, j: number) => (rng(j) > 0 ? num / rng(j) : 0);

  // signed run of same-direction candles (clipped to ±6)
  let run = 0;
  for (let j = 1; j <= i; j++) {
    const d = Math.sign(c[j] - o[j]);
    run = d !== 0 && (Math.sign(run) === 0 || Math.sign(run) === d) ? run + d : d;
  }
  run = Math.max(-6, Math.min(6, run));

  const r14 = rsi(c, 14)[i];
  const r7 = rsi(c, 7)[i];
  const bb = bollinger(c, 20, 2);
  const m = macd(c, 12, 26, 9).histogram;
  const e9 = ema(c, 9)[i];
  const e21 = ema(c, 21);
  const e50 = ema(c, 50)[i];
  if ([r14, r7, bb.percentB[i], bb.upper[i], m[i], m[i - 1], e9, e21[i], e21[i - 3], e50].some((v) => v === null)) return null;

  // ATR percentile among the last 100 ATR values (incl. current) and ATR vs mean true range
  const atrWin = a.slice(-100);
  if (atrWin.length < 100 || atrWin.some((v) => v === null)) return null;
  let below = 0;
  let equal = 0;
  for (const v of atrWin as number[]) {
    if (v < at) below++;
    else if (v === at) equal++;
  }
  const tr = trueRange(candles).slice(-100);
  const trMean = tr.reduce((s, v) => s + v, 0) / tr.length;

  const prior = candles.slice(i - 20, i);
  const last20 = candles.slice(i - 19, i + 1);
  const hi20 = Math.max(...prior.map((x) => x.high));
  const lo20 = Math.min(...prior.map((x) => x.low));
  const hi20i = Math.max(...last20.map((x) => x.high));
  const lo20i = Math.min(...last20.map((x) => x.low));

  // last COMPLETE 5-minute bucket ending at or before candle i's close
  const t = candles[i].time;
  const bucketEnd = Math.floor(t / (5 * M)) * 5 * M + 5 * M;
  const start5 = t + M === bucketEnd ? bucketEnd - 5 * M : bucketEnd - 10 * M;
  const bucket = candles.filter((x) => x.time >= start5 && x.time < start5 + 5 * M);
  if (bucket.length !== 5) return null;
  const r5 = (bucket[4].close - bucket[0].open) / at;

  const d = new Date(t);
  const hour = d.getUTCHours();
  return {
    ret1: ret(1),
    ret2: ret(2),
    ret3: ret(3),
    ret5: ret(5),
    ret10: ret(10),
    ret20: ret(20),
    ret60: ret(60),
    run,
    body: ratio(c[i] - o[i], i),
    upw: ratio(h[i] - Math.max(o[i], c[i]), i),
    loww: ratio(Math.min(o[i], c[i]) - l[i], i),
    rangeAtr: rng(i) / atPrev,
    bodyAtr: (c[i] - o[i]) / at,
    prevBody: ratio(c[i - 1] - o[i - 1], i - 1),
    rsi14: r14 as number,
    rsi7: r7 as number,
    pb: bb.percentB[i] as number,
    macdh: (m[i] as number) / at,
    macdhD: ((m[i] as number) - (m[i - 1] as number)) / at,
    ema9_21: ((e9 as number) - (e21[i] as number)) / at,
    c_ema50: (c[i] - (e50 as number)) / at,
    ema21slope: ((e21[i] as number) - (e21[i - 3] as number)) / at,
    atrPct: ((below + 0.5 * equal) / 100) * 100,
    atrRatio: at / trMean,
    bbwAtr: ((bb.upper[i] as number) - (bb.lower[i] as number)) / at,
    distHi20: (hi20 - c[i]) / at,
    distLo20: (c[i] - lo20) / at,
    pos20: hi20i > lo20i ? (c[i] - lo20i) / (hi20i - lo20i) : 0.5,
    r5,
    hourSin: Math.sin((2 * Math.PI * hour) / 24),
    hourCos: Math.cos((2 * Math.PI * hour) / 24),
    dow: (d.getUTCDay() + 6) % 7, // Monday = 0, as in pandas
    min5: Math.floor(t / M) % 5,
  };
}
