# Market data sources

## What was checked, and how

Endpoint shapes for the implemented adapter were taken from the provider's official open-source client, not guessed:

- **Twelve Data** — `github.com/twelvedata/twelvedata-python`: base URL `https://api.twelvedata.com`; `GET /time_series` with `symbol`, `interval`, `outputsize`, `timezone`, `order`, `apikey`; `GET /forex_pairs`; error bodies `{status: "error", code, message}`; rows in `values[]` keyed by `datetime`.
- **OANDA v20** — `github.com/oanda/v20-javascript`: `GET /v3/instruments/{instrument}/candles` with `price`, `granularity`, `count`, `from`, `to`; `Authorization: Bearer <token>`; candles carry `time`, `complete`, and `mid`/`bid`/`ask` `o/h/l/c`.

Pricing pages and terms of service could not be fetched from the build environment, so plan limits, prices and redistribution terms are **not** quoted here. Check them yourself before going live; they change.

## Comparison

| | Twelve Data | OANDA v20 | Polygon.io (forex) | Quotex |
|---|---|---|---|---|
| Adapter in this repo | **Implemented** (`src/lib/providers/twelvedata.ts`) | Planned | Planned | Not possible |
| Coverage | Regular FX pairs (and other assets) | Broker FX/CFD instruments | FX aggregates/quotes | — |
| 1-minute history | Yes (`interval=1min`) | Yes (`granularity=M1`), bid/ask/mid | Yes (minute aggregates) | — |
| Timestamps | `datetime` string; we request `timezone=UTC` | RFC3339 / Unix, with `complete` flag | Unix ms | — |
| OTC (Quotex) prices | **No** | **No** | **No** | Broker-internal only |
| Auth | API key (query param) | Bearer token + account | API key | No public API |
| Latency / limits / cost | Verify current plan | Verify; account required | Verify current plan | — |

## Why OTC is never "live" here

Quotex OTC quotes are produced by the broker itself, typically when regular markets are closed. No permitted third-party feed publishes them, and a regular EUR/USD feed is a different price series. The app therefore:

- keeps Regular and OTC strictly separate,
- refuses OTC analysis from any regular-market provider (*NO TRADE — no verified data source for broker OTC prices*),
- does not use unofficial Quotex APIs, websockets, scrapers or browser automation (those would breach the broker's terms and need account credentials).

Screenshots are the only OTC input, and screenshot interpretation is not implemented yet (see README).

## Adding a provider

Implement `MarketDataProvider` in `src/lib/providers/types.ts`:

- `verified` — `true` only for a real, permitted market feed
- `supportedMarketTypes` — `["LIVE"]` for any regular-market feed
- `listSymbols(marketType)` — only symbols the provider really offers
- `getCandles({symbol, marketType, count})` — ascending, minute-aligned UTC candles; it may include the forming candle (the engine drops it)
- `health()` — status without secrets
- throw `ProviderError(publicMessage, status)` — never pass raw upstream bodies to users

Register it in `src/lib/providers/registry.ts`, read its key in `src/lib/server/env.ts` (no `NEXT_PUBLIC_` prefix), and add parser tests against the provider's documented response shape.

## Economic calendar

No verified calendar provider is configured. `NewsContext` in the engine is ready for one: supply `available: true` and the list of high-impact events inside your blackout window, and signals will be blocked during them.
