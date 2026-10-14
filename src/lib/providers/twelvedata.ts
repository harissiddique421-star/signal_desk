import { z } from "zod";
import type { Candle, MarketType, ProviderSymbol } from "../types";
import type { CandleRequest, CandleResponse, MarketDataProvider, ProviderHealth } from "./types";
import { ProviderError } from "./types";

/**
 * Twelve Data adapter (regular FX market only — it does NOT provide broker OTC quotes).
 *
 * Endpoint shapes were taken from Twelve Data's official client
 * (github.com/twelvedata/twelvedata-python): base https://api.twelvedata.com,
 * GET /time_series (symbol, interval, outputsize, timezone, order, apikey) and
 * GET /forex_pairs; errors come back as {status:"error", code, message}.
 * Not exercised against the live API in this repo's tests (no key available);
 * the parsing is unit-tested against those documented shapes.
 */

const BASE_URL = "https://api.twelvedata.com";
const SYMBOL_RE = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/;

/** Most-traded pairs, listed first so users do not scroll past exotic crosses. */
export const MAJOR_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD",
  "EUR/JPY", "GBP/JPY", "EUR/GBP", "AUD/JPY", "EUR/AUD", "EUR/CHF", "GBP/AUD", "AUD/CAD", "CAD/JPY", "CHF/JPY",
];

export function sortMajorsFirst(symbols: string[]): string[] {
  const rank = (s: string) => {
    const i = MAJOR_PAIRS.indexOf(s);
    return i === -1 ? MAJOR_PAIRS.length : i;
  };
  return [...symbols].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const ErrorSchema = z.object({ status: z.literal("error"), code: z.number().optional(), message: z.string().optional() });

const ValueSchema = z.object({
  datetime: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/),
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
  volume: z.coerce.number().optional(),
});

const TimeSeriesSchema = z.object({
  meta: z.object({ symbol: z.string(), interval: z.string() }).loose(),
  values: z.array(ValueSchema),
  status: z.string().optional(),
});

const ForexPairsSchema = z.object({
  data: z.array(z.object({ symbol: z.string() }).loose()),
});

/** Parse "YYYY-MM-DD HH:mm[:ss]" as UTC (we always request timezone=UTC). */
export function parseUtcDatetime(s: string): number {
  const iso = s.replace(" ", "T") + (s.length === 16 ? ":00" : "") + "Z";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new ProviderError("Provider returned an unparseable timestamp");
  return t;
}

export function parseTimeSeries(json: unknown, expectedSymbol: string): Candle[] {
  const err = ErrorSchema.safeParse(json);
  if (err.success) {
    const code = err.data.code ?? 502;
    const msg =
      code === 401 ? "Market data API key rejected" : code === 429 ? "Market data rate limit reached — try again shortly" : code === 404 || code === 400 ? "Symbol or request not accepted by the provider" : "Market data provider error";
    throw new ProviderError(msg, code === 429 ? 429 : 502);
  }
  const parsed = TimeSeriesSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError("Provider response did not match the expected format");
  if (parsed.data.meta.symbol !== expectedSymbol) throw new ProviderError("Provider returned data for a different symbol");
  if (parsed.data.meta.interval !== "1min") throw new ProviderError("Provider returned a different interval");
  return parsed.data.values
    .map((v) => ({ time: parseUtcDatetime(v.datetime), open: v.open, high: v.high, low: v.low, close: v.close, ...(v.volume !== undefined ? { volume: v.volume } : {}) }))
    .sort((a, b) => a.time - b.time);
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = "twelvedata";
  readonly name = "Twelve Data";
  readonly verified = true;
  readonly supportedMarketTypes: MarketType[] = ["LIVE"];
  private lastOk: number | null = null;
  private lastError: { at: number; message: string } | null = null;
  private lastLatency: number | null = null;
  private symbolCache: { at: number; symbols: ProviderSymbol[] } | null = null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured() {
    return !!this.apiKey;
  }

  private async call(path: string, params: Record<string, string>): Promise<{ json: unknown; latencyMs: number }> {
    if (!this.apiKey) throw new ProviderError("Twelve Data is not configured", 503);
    const url = new URL(path, BASE_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", this.apiKey);
    const started = Date.now();
    try {
      const res = await this.fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - started;
      this.lastLatency = latencyMs;
      if (res.status === 429) throw new ProviderError("Market data rate limit reached — try again shortly", 429);
      if (res.status === 401 || res.status === 403) throw new ProviderError(`Market data API key rejected (HTTP ${res.status}) — check TWELVEDATA_API_KEY in Vercel, then redeploy`, 502);
      if (!res.ok) throw new ProviderError(`Market data provider HTTP ${res.status}`, 502);
      const json = await res.json();
      return { json, latencyMs };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("Market data provider unreachable", 502, e);
      this.lastError = { at: Date.now(), message: pe.publicMessage };
      throw pe;
    }
  }

  async listSymbols(marketType: MarketType): Promise<ProviderSymbol[]> {
    if (marketType !== "LIVE") return [];
    if (this.symbolCache && Date.now() - this.symbolCache.at < 6 * 3600_000) return this.symbolCache.symbols;
    const { json } = await this.call("/forex_pairs", {});
    const parsed = ForexPairsSchema.safeParse(json);
    if (!parsed.success) throw new ProviderError("Provider symbol list did not match the expected format");
    const symbols = sortMajorsFirst(parsed.data.data.map((d) => d.symbol).filter((s) => SYMBOL_RE.test(s)))
      .map((s) => {
        const [base, quote] = s.split("/");
        return { symbol: s, displaySymbol: s, marketType: "LIVE" as const, base, quote };
      });
    this.symbolCache = { at: Date.now(), symbols };
    this.lastOk = Date.now();
    return symbols;
  }

  async getCandles(req: CandleRequest): Promise<CandleResponse> {
    if (req.marketType !== "LIVE") throw new ProviderError("Twelve Data does not provide OTC prices", 400);
    if (!SYMBOL_RE.test(req.symbol)) throw new ProviderError("Invalid symbol format", 400);
    const { json, latencyMs } = await this.call("/time_series", {
      symbol: req.symbol,
      interval: "1min",
      outputsize: String(Math.min(Math.max(req.count, 1), 5000)),
      timezone: "UTC",
      order: "asc",
    });
    try {
      const candles = parseTimeSeries(json, req.symbol);
      this.lastOk = Date.now();
      return { candles, receivedAt: Date.now(), latencyMs };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("Provider response invalid", 502, e);
      this.lastError = { at: Date.now(), message: pe.publicMessage };
      throw pe;
    }
  }

  async health(): Promise<ProviderHealth> {
    const now = Date.now();
    if (!this.apiKey) {
      return { id: this.id, name: this.name, status: "NOT_CONFIGURED", verified: true, supportedMarketTypes: this.supportedMarketTypes, latencyMs: null, checkedAt: now, detail: "TWELVEDATA_API_KEY is not set" };
    }
    const recentError = this.lastError && (!this.lastOk || this.lastError.at > this.lastOk);
    return {
      id: this.id,
      name: this.name,
      status: recentError ? "DEGRADED" : "OK",
      verified: true,
      supportedMarketTypes: this.supportedMarketTypes,
      latencyMs: this.lastLatency,
      checkedAt: now,
      detail: recentError ? `Last request failed: ${this.lastError!.message}` : this.lastOk ? `Last successful request ${Math.round((now - this.lastOk) / 1000)}s ago` : "Configured; no request made yet",
    };
  }
}
