import type { Candle, Decision } from "../types";
import { computeFeatures, FEATURE_NAMES, type FeatureVector } from "./features";
import modelJson from "./model-v3.json";

/**
 * v3 shadow model: a LightGBM classifier (52 trees) trained on TRAIN only,
 * calibrated with isotonic regression and given an abstention margin θ on
 * VALIDATION, then frozen. TEST result: see docs/RESEARCH.md §9.
 *
 * It runs in SHADOW mode only: its decisions are recorded for comparison and
 * never shown as a tradable signal.
 */
type Node = ["L", number] | [number, number | number[], 0 | 1, number, number, string];

interface ModelFile {
  version: string;
  features: string[];
  pairs: string[];
  theta: number;
  isotonic: { x: number[]; y: number[] };
  trees: Node[][];
  testResult: { winRate: number; ci95: [number, number]; wins: number; losses: number; coverage: number };
}

const MODEL = modelJson as unknown as ModelFile;

export const SHADOW_MODEL_VERSION = MODEL.version;
export const SHADOW_MODEL_TEST = MODEL.testResult;

/** "EUR/USD" → category code used in training, or null for pairs the model never saw. */
export function pairCode(symbol: string): number | null {
  const i = MODEL.pairs.indexOf(symbol.replace("/", "_").toUpperCase());
  return i === -1 ? null : i;
}

function treeValue(nodes: Node[], x: number[]): number {
  let k = 0;
  for (;;) {
    const n = nodes[k];
    if (n[0] === "L") return n[1];
    const [f, thr, , left, right] = n;
    const v = x[f];
    const goLeft = Array.isArray(thr) ? thr.includes(v) : v <= thr;
    k = goLeft ? left : right;
  }
}

/** np.interp with clipping, as sklearn IsotonicRegression(out_of_bounds="clip").predict */
export function isotonic(p: number, xs = MODEL.isotonic.x, ys = MODEL.isotonic.y): number {
  if (p <= xs[0]) return ys[0];
  if (p >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= p) lo = mid;
    else hi = mid;
  }
  const t = xs[hi] === xs[lo] ? 0 : (p - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

export interface ShadowPrediction {
  /** Raw model probability that the next candle closes up */
  rawProbability: number;
  /** Calibrated probability (isotonic, fitted on VALIDATION) */
  probability: number;
  decision: Decision;
  features: FeatureVector;
}

export function predictRaw(features: FeatureVector, pair: number): number {
  const order = MODEL.features;
  if (order.length !== FEATURE_NAMES.length + 1 || order[order.length - 1] !== "pair") throw new Error("model feature order mismatch");
  const x = [...FEATURE_NAMES.map((f, j) => {
    if (order[j] !== f) throw new Error(`model feature ${j} is ${order[j]}, expected ${f}`);
    return features[f];
  }), pair];
  let raw = 0;
  for (const t of MODEL.trees) raw += treeValue(t, x);
  return 1 / (1 + Math.exp(-raw));
}

export function decideFromProbability(p: number, theta = MODEL.theta): Decision {
  return p >= 0.5 + theta ? "CALL" : p <= 0.5 - theta ? "PUT" : "NO_TRADE";
}

/** Prediction on the last candle of `closedCandles` (they must already be closed and gap-checked). */
export function shadowPredict(closedCandles: Candle[], symbol: string): ShadowPrediction | null {
  const code = pairCode(symbol);
  if (code === null) return null;
  const f = computeFeatures(closedCandles);
  if (!f || Object.values(f).some((v) => !Number.isFinite(v))) return null;
  const raw = predictRaw(f, code);
  const p = isotonic(raw);
  return { rawProbability: raw, probability: p, decision: decideFromProbability(p), features: f };
}
