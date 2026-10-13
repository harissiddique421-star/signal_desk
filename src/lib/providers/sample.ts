import type { Candle, MarketType, ProviderSymbol } from "../types";
import type { CandleRequest, CandleResponse, MarketDataProvider, ProviderHealth } from "./types";
import { ProviderError } from "./types";

const M = 60_000;

/**
 * Deterministic SYNTHETIC data for development and tests. Symbols are named
 * SAMPLE-* on purpose so they can never be mistaken for a real pair, and the
 * provider reports verified=false, so the engine never emits a tradable signal
 * from it.
 */
export const SAMPLE_SYMBOLS: ProviderSymbol[] = [
  { symbol: "SAMPLE-TREND", displaySymbol: "SAMPLE-TREND (synthetic)", marketType: "LIVE" },
  { symbol: "SAMPLE-RANGE", displaySymbol: "SAMPLE-RANGE (synthetic)", marketType: "LIVE" },
  { symbol: "SAMPLE-OTC", displaySymbol: "SAMPLE-OTC (synthetic)", marketType: "OTC" },
];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Generate synthetic 1-minute candles that END at the last minute that has
 * fully closed before `now` (plus the forming candle, like real feeds do).
 * Generation starts at a fixed anchor 3 days back so the same minute always
 * yields the same candle.
 */
export function generateSampleCandles(symbol: string, now: number, count: number): Candle[] {
  const anchor = Math.floor(now / 86_400_000) * 86_400_000 - 3 * 86_400_000;
  const formingOpen = Math.floor(now / M) * M;
  const rand = mulberry32(hashString(symbol) ^ anchor / M);
  const trending = symbol.includes("TREND");
  let price = 1 + (hashString(symbol) % 1000) / 2000;
  let drift = 0;
  const out: Candle[] = [];
  const startKeep = formingOpen - (count - 1) * M;
  for (let t = anchor; t <= formingOpen; t += M) {
    if ((t / M) % 45 === 0) drift = trending ? (rand() - 0.5) * 0.0002 : 0;
    const vol = 0.00025 * (0.6 + rand());
    const open = price;
    const close = open * (1 + drift + vol * gauss(rand) - (trending ? 0 : (open - 1.25) * 0.02));
    const high = Math.max(open, close) * (1 + Math.abs(vol * 0.6 * gauss(rand)));
    const low = Math.min(open, close) * (1 - Math.abs(vol * 0.6 * gauss(rand)));
    price = close;
    if (t >= startKeep) out.push({ time: t, open: r(open), high: r(high), low: r(low), close: r(close) });
  }
  return out;
}

function r(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

export class SampleProvider implements MarketDataProvider {
  readonly id = "sample";
  readonly name = "Sample data (synthetic)";
  readonly verified = false;
  readonly supportedMarketTypes: MarketType[] = ["LIVE", "OTC"];

  constructor(private readonly clock: () => number = Date.now) {}

  isConfigured() {
    return true;
  }

  async listSymbols(marketType: MarketType) {
    return SAMPLE_SYMBOLS.filter((s) => s.marketType === marketType);
  }

  async getCandles(req: CandleRequest): Promise<CandleResponse> {
    const sym = SAMPLE_SYMBOLS.find((s) => s.symbol === req.symbol && s.marketType === req.marketType);
    if (!sym) throw new ProviderError(`Unknown sample symbol ${req.symbol}`, 404);
    const now = this.clock();
    return { candles: generateSampleCandles(req.symbol, now, req.count), receivedAt: now, latencyMs: 0 };
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      name: this.name,
      status: "OK",
      verified: false,
      supportedMarketTypes: this.supportedMarketTypes,
      latencyMs: 0,
      checkedAt: this.clock(),
      detail: "Synthetic data for testing. Not a market feed.",
    };
  }
}
