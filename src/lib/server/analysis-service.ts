import "server-only";
import { DEFAULT_RULES, RuleConfigSchema, type RuleConfig } from "../config/rules";
import { MODE_OVERRIDES, type SignalMode } from "../config/presets";
import { evaluateSignal, type EngineInput } from "../engine/signal";
import { shadowDecisions } from "../engine/shadow";
import { bollinger, ema } from "../indicators";
import { buildZones, findSwings } from "../analysis/structure";
import { atr } from "../indicators";
import { closedCandlesOnly } from "../validation/candles";
import { getProvider } from "../providers/registry";
import type { MarketDataProvider } from "../providers/types";
import type { Candle, MarketType } from "../types";
import type { AnalyzeResponse, ChartPayload } from "../api/contracts";
import { HttpError } from "./http";

export function resolveProvider(id: string): MarketDataProvider {
  const p = getProvider(id);
  if (!p) throw new HttpError(404, "Unknown data provider");
  if (!p.isConfigured()) throw new HttpError(503, `${p.name} is not configured on this deployment — live data unavailable`);
  return p;
}

export function mergeRules(overrides?: Partial<RuleConfig>, mode: SignalMode = "V2"): RuleConfig {
  const merged = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES[mode], ...(overrides ?? {}) });
  if (merged.emaFast >= merged.emaSlow) throw new HttpError(400, "emaFast must be shorter than emaSlow");
  if (merged.macdFast >= merged.macdSlow) throw new HttpError(400, "macdFast must be shorter than macdSlow");
  if (merged.minAtrPercentile >= merged.maxAtrPercentile) throw new HttpError(400, "minAtrPercentile must be below maxAtrPercentile");
  return merged;
}

export async function analyze(params: { providerId: string; symbol: string; marketType: MarketType; mode?: SignalMode; rules?: Partial<RuleConfig> }): Promise<AnalyzeResponse> {
  const cfg = mergeRules(params.rules, params.mode);
  const provider = resolveProvider(params.providerId);
  const source = { id: provider.id, name: provider.name, verified: provider.verified, supportedMarketTypes: provider.supportedMarketTypes };
  const analysisKind = provider.verified ? "LIVE_FEED" : "SAMPLE";

  // Unsupported market type: answer NO_TRADE without calling the provider at all.
  if (!provider.supportedMarketTypes.includes(params.marketType)) {
    const result = evaluateSignal({ candles: [], symbol: params.symbol, marketType: params.marketType, symbolSupported: false, source, analysisKind, now: Date.now(), config: cfg });
    return { result, chart: null, provider: { id: provider.id, name: provider.name, verified: provider.verified, latencyMs: 0 } };
  }

  const symbols = await provider.listSymbols(params.marketType);
  const sym = symbols.find((s) => s.symbol === params.symbol);
  if (!sym) {
    const result = evaluateSignal({ candles: [], symbol: params.symbol, marketType: params.marketType, symbolSupported: false, source, analysisKind, now: Date.now(), config: cfg });
    return { result, chart: null, provider: { id: provider.id, name: provider.name, verified: provider.verified, latencyMs: 0 } };
  }

  const count = Math.max(cfg.minCandles + cfg.volatilityWindow + 40, 300);
  const resp = await provider.getCandles({ symbol: params.symbol, marketType: params.marketType, count });
  // Evaluate at the time the data was received, so the freshness check reflects reality.
  const now = Math.max(Date.now(), resp.receivedAt);
  const input: EngineInput = { candles: resp.candles, symbol: sym.symbol, displaySymbol: sym.displaySymbol, marketType: params.marketType, symbolSupported: true, source, analysisKind, now };
  const result = evaluateSignal({ ...input, config: cfg });
  const shadow = shadowDecisions(input, params.mode ?? "V2", result);
  return { result, chart: buildChart(resp.candles, now, cfg), provider: { id: provider.id, name: provider.name, verified: provider.verified, latencyMs: resp.latencyMs }, shadow };
}

function buildChart(raw: Candle[], now: number, cfg: RuleConfig): ChartPayload | null {
  const closed = closedCandlesOnly(raw, cfg.timeframeSeconds * 1000, now);
  if (closed.length < 30) return null;
  const closes = closed.map((c) => c.close);
  const show = 90;
  const start = Math.max(0, closed.length - show);
  const ef = ema(closes, cfg.emaFast);
  const es = ema(closes, cfg.emaSlow);
  const bb = bollinger(closes, cfg.bbPeriod, cfg.bbStdDev);
  const a = atr(closed, cfg.atrPeriod)[closed.length - 1];
  const swings = findSwings(closed.slice(-cfg.levelLookback), cfg.swingStrength);
  const price = closes[closes.length - 1];
  const all = a ? buildZones(swings, price, cfg.levelMergeAtr * a).filter((z) => z.touches >= 2) : [];
  // Show only the two nearest zones on each side to keep the chart readable.
  const nearest = (kind: "SUPPORT" | "RESISTANCE") =>
    all.filter((z) => z.kind === kind).sort((x, y) => Math.abs(x.mid - price) - Math.abs(y.mid - price)).slice(0, 2);
  const zones = [...nearest("SUPPORT"), ...nearest("RESISTANCE")];
  return {
    candles: closed.slice(start),
    emaFast: ef.slice(start),
    emaSlow: es.slice(start),
    bbUpper: bb.upper.slice(start),
    bbLower: bb.lower.slice(start),
    zones: zones.map((z) => ({ kind: z.kind, low: z.low, high: z.high, touches: z.touches })),
  };
}

