/**
 * Download recent 1-minute candles from Dukascopy's public historical feed
 * (tick-built, the same kind of data as the OANDA history v2 was designed on),
 * so v2 can be re-checked on today's market without a broker account.
 *
 *   npx tsx scripts/research/fetch-dukascopy.ts --out data-dukascopy --days 60
 *
 * Writes <out>/<PAIR>/dukascopy.csv (time,open,high,low,close; UTC open time) in
 * the format load-candles.ts reads, plus <out>/fetch-meta.json.
 *
 * Prices: Dukascopy publishes BID and ASK candles; this script fetches both and
 * stores the MID ((bid + ask) / 2 per field), matching the OANDA mid candles used
 * in docs/RESEARCH.md. Minutes without ticks ("flat" candles) are dropped, as
 * OANDA omits them; nothing is filled in. Dukascopy publishes only finished
 * periods, so this is for research, not for live signals.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHistoricalRates } from "dukascopy-node";
import type { Candle } from "../../src/lib/types";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const outDir = args.get("out") ?? "data-dukascopy";
const days = Number(args.get("days") ?? 60);
const pairs = (args.get("pairs") ?? "EUR/USD,GBP/USD,USD/CAD,AUD/USD,EUR/JPY,AUD/JPY").split(",");

type Instrument = Parameters<typeof getHistoricalRates>[0]["instrument"];

async function side(instrument: Instrument, priceType: "bid" | "ask", from: Date, to: Date) {
  const rows = await getHistoricalRates({
    instrument,
    dates: { from, to },
    timeframe: "m1",
    priceType,
    format: "json",
    volumes: false,
    ignoreFlats: true,
    batchSize: 10,
    pauseBetweenBatchesMs: 500,
    retryCount: 3,
    failAfterRetryCount: true,
  });
  return new Map(rows.map((r) => [r.timestamp, r]));
}

async function main() {
  const until = Date.now();
  const to = new Date(until);
  const from = new Date(until - days * 86_400_000);
  const meta: Record<string, unknown> = { provider: "Dukascopy (public historical feed)", price: "mid of bid/ask", interval: "1min", requestedDays: days, fetchedAt: to.toISOString(), pairs: {} };
  for (const symbol of pairs) {
    const instrument = symbol.replace("/", "").toLowerCase() as Instrument;
    const [bid, ask] = [await side(instrument, "bid", from, to), await side(instrument, "ask", from, to)];
    const candles: Candle[] = [];
    let unmatched = 0;
    for (const [t, b] of bid) {
      const a = ask.get(t);
      if (!a) {
        unmatched++;
        continue;
      }
      if (t + 60_000 > until) continue; // still forming
      const mid = (x: number, y: number) => Math.round(((x + y) / 2) * 1e6) / 1e6;
      const c = { time: t, open: mid(b.open, a.open), high: mid(b.high, a.high), low: mid(b.low, a.low), close: mid(b.close, a.close) };
      // Averaging highs/lows of two sides can, rarely, put open/close outside [low, high]; widen rather than drop.
      c.high = Math.max(c.high, c.open, c.close);
      c.low = Math.min(c.low, c.open, c.close);
      candles.push(c);
    }
    candles.sort((x, y) => x.time - y.time);
    const dir = join(outDir, symbol.replace("/", "_"));
    mkdirSync(dir, { recursive: true });
    const rows = ["time,open,high,low,close", ...candles.map((c) => `${new Date(c.time).toISOString()},${c.open},${c.high},${c.low},${c.close}`)];
    writeFileSync(join(dir, "dukascopy.csv"), rows.join("\n") + "\n");
    (meta.pairs as Record<string, unknown>)[symbol] = {
      candles: candles.length,
      unmatchedBidMinutes: unmatched,
      first: candles[0] ? new Date(candles[0].time).toISOString() : null,
      last: candles.length ? new Date(candles[candles.length - 1].time).toISOString() : null,
    };
    console.error(`${symbol}: ${candles.length} candles`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "fetch-meta.json"), JSON.stringify(meta, null, 1) + "\n");
}

main().catch((e) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(msg);
  // Shown as an annotation on the GitHub Actions run (logs are not always reachable).
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${msg.replace(/\r?\n/g, " ").slice(0, 900)}`);
  process.exit(1);
});
