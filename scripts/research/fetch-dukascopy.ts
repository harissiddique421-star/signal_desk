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
import { BufferFetcher, generateUrls, getHistoricalRates, normaliseDates, processData } from "dukascopy-node";
import type { Candle } from "../../src/lib/types";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const outDir = args.get("out") ?? "data-dukascopy";
const days = Number(args.get("days") ?? 60);
const pairs = (args.get("pairs") ?? "EUR/USD,GBP/USD,USD/CAD,AUD/USD,EUR/JPY,AUD/JPY").split(",");
const batch = Number(args.get("batch") ?? 4);
const pauseMs = Number(args.get("pause") ?? 750);

type Instrument = Parameters<typeof getHistoricalRates>[0]["instrument"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

/**
 * Dukascopy's data feed sometimes answers 202 (request accepted, data not served
 * yet) or 429/5xx, especially to cloud IPs. The library's own fetcher treats any
 * non-200 as an error, so requests go through this one: browser-like headers,
 * exponential back-off on 202/429/5xx, and an empty buffer for 404 (no data that hour/day).
 */
async function fetchWithBackoff(url: string): Promise<Buffer> {
  let last = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    requests++;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        Referer: "https://www.dukascopy.com/swiss/english/marketwatch/historical/",
        Accept: "*/*",
      },
      signal: AbortSignal.timeout(30_000),
    });
    last = res.status;
    if (res.status === 200) return Buffer.from(await res.arrayBuffer());
    if (res.status === 404) return Buffer.from("");
    await res.arrayBuffer().catch(() => null);
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
  }
  throw new Error(`Dukascopy kept answering HTTP ${last} for ${url.split("/datafeed/")[1] ?? url}`);
}

async function side(instrument: Instrument, priceType: "bid" | "ask", from: Date, to: Date) {
  const [startDate, endDate] = normaliseDates({ instrument, startDate: from, endDate: to, timeframe: "m1", utcOffset: 0 });
  const urls = generateUrls({ instrument, timeframe: "m1", priceType, startDate, endDate });
  const fetcher = new BufferFetcher({ batchSize: batch, pauseBetweenBatchesMs: pauseMs, fetcherFn: fetchWithBackoff, retryCount: 0, retryOnEmpty: false, failAfterRetryCount: true, pauseBetweenRetriesMs: 0 });
  const buffers = await fetcher.fetch(urls);
  const processed = processData({ instrument, requestedTimeframe: "m1", bufferObjects: buffers, priceType, volumes: false, volumeUnits: "millions", ignoreFlats: true });
  const rows = processed.filter(([t]) => t && t >= +startDate && t < +endDate);
  // processData rows: [timestamp, open, high, low, close]
  return new Map(rows.map((r) => [r[0], { timestamp: r[0], open: r[1], high: r[2], low: r[3], close: r[4] }]));
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
    console.error(`${symbol}: ${candles.length} candles (${requests} requests so far)`);
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
