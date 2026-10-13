import "server-only";
import { serverEnv } from "../server/env";
import { SampleProvider } from "./sample";
import { TwelveDataProvider } from "./twelvedata";
import type { MarketDataProvider } from "./types";

let providers: MarketDataProvider[] | null = null;

/** All providers known to the app (configured or not), created once per server instance. */
export function allProviders(): MarketDataProvider[] {
  if (providers) return providers;
  const env = serverEnv();
  const list: MarketDataProvider[] = [new TwelveDataProvider(env.TWELVEDATA_API_KEY)];
  if (env.ENABLE_SAMPLE_PROVIDER === "true") list.push(new SampleProvider());
  providers = list;
  return providers;
}

export function getProvider(id: string): MarketDataProvider | undefined {
  return allProviders().find((p) => p.id === id);
}

/** True when at least one verified live provider has credentials. */
export function liveDataAvailable(): boolean {
  return allProviders().some((p) => p.verified && p.isConfigured());
}
