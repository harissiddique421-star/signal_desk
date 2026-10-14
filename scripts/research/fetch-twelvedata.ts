/**
 * Download recent 1-minute candles from Twelve Data — the same feed the live app
 * uses — so the shipped rules can be re-checked on today's market instead of the
 * 2018–2020 OANDA history.
 *
 *   TWELVEDATA_API_KEY=... npx tsx scripts/research/fetch-twelvedata.ts --out data-recent --days 60
 *
 * Writes <out>/<PAIR>/twelvedata.csv (time,open,high,low,close; UTC open time),
 * the format scripts/research/load-candles.ts reads, plus <out>/fetch-meta.json.
 *
 * Paging: each call asks for the 5,000 candles ending at `end_date`, then the next
 * call ends at the earliest candle received. Overlaps are de-duplicated; nothing is
 * filled in. The free plan allows about 8 calls per minute, so calls are spaced
 * (--rpm, default 7) and a 429 waits a minute and retries. If the plan has less
 * history than requested, paging stops when the provider returns nothing older,
 * and the meta file records the period actually covered.
 *
 * The key is read from the environment only and never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTimeSeries } from "../../src/lib/providers/twelvedata";
import type { Candle } from "../../src/lib/types";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const outDir = args.get("out") ?? "data-recent";
const days = Number(args.get("days") ?? 60);
const rpm = Number(args.get("rpm") ?? 7);
const pairs = (args.get("pairs") ?? "EUR/USD,GBP/USD,USD/CAD,AUD/USD,EUR/JPY,AUD/JPY").split(",");
const key = process.env.TWELVEDATA_API_KEY;
if (!key) {
  console.error("TWELVEDATA_API_KEY is not set (add it as a GitHub Actions secret or export it locally).");
  process.exit(2);
}

const PAGE = 5000;
const gapMs = Math.ceil(60_000 / rpm);
let lastCall = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");

async function page(symbol: string, endMs: number): Promise<Candle[]> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = lastCall + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const url = new URL("/time_series", process.env.TWELVEDATA_BASE_URL ?? "https://api.twelvedata.com"); // base override only for offline tests
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1min");
    url.searchParams.set("outputsize", String(PAGE));
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("end_date", fmt(endMs));
    url.searchParams.set("apikey", key!);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const json = (await res.json().catch(() => null)) as { status?: string; code?: number; message?: string } | null;
    if (res.status === 429 || json?.code === 429) {
      console.error(`  rate limit, waiting 65 s (attempt ${attempt})`);
      await sleep(65_000);
      continue;
    }
    if (json?.status === "error") {
      // 400 "No data is available on the specified dates" = we reached the start of the plan's history.
      if (json.code === 400 || json.code === 404) return [];
      if (json.code === 401) throw new Error("Twelve Data rejected the API key (401)");
      throw new Error(`Twelve Data error ${json.code ?? res.status}`);
    }
    return parseTimeSeries(json, symbol);
  }
  throw new Error("Twelve Data rate limit did not clear after 4 attempts");
}

async function main() {
  const until = Date.now();
  const from = until - days * 86_400_000;
  const meta: Record<string, unknown> = { provider: "Twelve Data", interval: "1min", requestedDays: days, fetchedAt: new Date(until).toISOString(), pairs: {} };
  for (const symbol of pairs) {
    const byTime = new Map<number, Candle>();
    let end = until;
    let calls = 0;
    while (end > from) {
      const got = await page(symbol, end);
      calls++;
      const fresh = got.filter((c) => !byTime.has(c.time));
      for (const c of fresh) byTime.set(c.time, c);
      if (fresh.length === 0) break; // no older data available
      const earliest = Math.min(...fresh.map((c) => c.time));
      if (earliest >= end) break; // no progress — stop rather than loop
      end = earliest;
      console.error(`  ${symbol}: ${byTime.size} candles back to ${fmt(earliest)}`);
    }
    // Drop the candle still forming at fetch time: its "close" is not final.
    const candles = [...byTime.values()].filter((c) => c.time >= from && c.time + 60_000 <= until).sort((a, b) => a.time - b.time);
    const dir = join(outDir, symbol.replace("/", "_"));
    mkdirSync(dir, { recursive: true });
    const rows = ["time,open,high,low,close", ...candles.map((c) => `${new Date(c.time).toISOString()},${c.open},${c.high},${c.low},${c.close}`)];
    writeFileSync(join(dir, "twelvedata.csv"), rows.join("\n") + "\n");
    (meta.pairs as Record<string, unknown>)[symbol] = {
      candles: candles.length,
      first: candles[0] ? new Date(candles[0].time).toISOString() : null,
      last: candles.length ? new Date(candles[candles.length - 1].time).toISOString() : null,
      calls,
    };
    console.error(`${symbol}: ${candles.length} candles (${calls} calls)`);
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
