import { BacktestRequestSchema } from "@/lib/api/schemas";
import { runBacktest } from "@/lib/backtest/backtest";
import { DEFAULT_RULES } from "@/lib/config/rules";
import { resolveProvider } from "@/lib/server/analysis-service";
import { enforceRateLimit, HttpError, json, readJson, safe } from "@/lib/server/http";
import { closedCandlesOnly } from "@/lib/validation/candles";

export async function POST(req: Request) {
  return safe(async () => {
    enforceRateLimit(req, "backtest", 6);
    const body = BacktestRequestSchema.parse(await readJson(req));
    const p = resolveProvider(body.provider);
    if (!p.supportedMarketTypes.includes(body.marketType)) throw new HttpError(400, `${p.name} has no ${body.marketType} data to backtest`);
    const symbols = await p.listSymbols(body.marketType);
    if (!symbols.some((s) => s.symbol === body.symbol)) throw new HttpError(404, "Symbol not offered by this provider");
    const resp = await p.getCandles({ symbol: body.symbol, marketType: body.marketType, count: body.count });
    const candles = closedCandlesOnly(resp.candles, 60_000, resp.receivedAt);
    if (candles.length < DEFAULT_RULES.minCandles + 50) throw new HttpError(422, `Only ${candles.length} closed candles returned; need at least ${DEFAULT_RULES.minCandles + 50}`);
    const result = runBacktest({
      candles,
      symbol: body.symbol,
      marketType: body.marketType,
      source: { id: p.id, name: p.name, verified: p.verified, supportedMarketTypes: p.supportedMarketTypes },
      payout: body.payout,
      inSampleFraction: body.inSampleFraction,
    });
    return json({
      synthetic: !p.verified,
      notice: p.verified
        ? "Historical simulation on provider candles. Past results do not guarantee future results."
        : "SYNTHETIC DATA: these numbers test the software only and say nothing about any real market.",
      // Trades list can be large; send the most recent 300 for display.
      result: { ...result, trades: result.trades.slice(-300) },
    });
  });
}
