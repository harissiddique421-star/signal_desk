import { ResolveRequestSchema } from "@/lib/api/schemas";
import { resolveProvider } from "@/lib/server/analysis-service";
import { enforceRateLimit, HttpError, json, readJson, safe } from "@/lib/server/http";
import { resolveSignal } from "@/lib/stats/resolve";

/**
 * Settle past CALL/PUT signals from the feed: entry = open of the candle after
 * the signal candle, expiry = its close. Feed-based, not broker settlement.
 */
export async function POST(req: Request) {
  return safe(async () => {
    enforceRateLimit(req, "resolve", 12);
    const body = ResolveRequestSchema.parse(await readJson(req));
    const p = resolveProvider(body.provider);
    if (!p.verified) throw new HttpError(400, "Only verified live feeds can settle signals");
    if (!p.supportedMarketTypes.includes(body.marketType)) throw new HttpError(400, `${p.name} has no ${body.marketType} data`);
    const oldest = Math.min(...body.signals.map((s) => s.signalCandleTime));
    const minutesBack = Math.ceil((Date.now() - oldest) / 60_000) + 5;
    if (minutesBack > 5000) throw new HttpError(422, "Signals are too old to settle from the feed");
    const resp = await p.getCandles({ symbol: body.symbol, marketType: body.marketType, count: Math.max(30, minutesBack) });
    const now = resp.receivedAt;
    return json({
      results: body.signals.map((s) => ({ id: s.id, ...resolveSignal(resp.candles, s.signalCandleTime, s.decision, now) })),
    });
  });
}
