import type { Candle, MarketType, ProviderSymbol } from "../types";

export type ProviderStatus = "OK" | "NOT_CONFIGURED" | "DEGRADED" | "DOWN";

export interface ProviderHealth {
  id: string;
  name: string;
  status: ProviderStatus;
  verified: boolean;
  supportedMarketTypes: MarketType[];
  latencyMs: number | null;
  checkedAt: number;
  detail: string;
}

export interface CandleRequest {
  symbol: string;
  marketType: MarketType;
  /** Number of most recent 1-minute candles wanted */
  count: number;
}

export interface CandleResponse {
  candles: Candle[];
  /** Server time when the provider answered */
  receivedAt: number;
  latencyMs: number;
}

/** Every market-data source implements this. Adapters run on the server only. */
export interface MarketDataProvider {
  readonly id: string;
  readonly name: string;
  /** True only for a real, permitted market-data feed */
  readonly verified: boolean;
  readonly supportedMarketTypes: MarketType[];
  isConfigured(): boolean;
  listSymbols(marketType: MarketType): Promise<ProviderSymbol[]>;
  getCandles(req: CandleRequest): Promise<CandleResponse>;
  health(): Promise<ProviderHealth>;
}

/** Error whose `publicMessage` is safe to show to users (no secrets, no raw upstream bodies). */
export class ProviderError extends Error {
  constructor(
    public readonly publicMessage: string,
    public readonly status: number = 502,
    cause?: unknown,
  ) {
    super(publicMessage, { cause });
    this.name = "ProviderError";
  }
}
