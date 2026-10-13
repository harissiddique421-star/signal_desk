import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../../src/lib/types";

/**
 * Load 1-minute candles from a folder of CSV files (one pair per folder).
 *
 * Expected header (column order does not matter): time,open,high,low,close[,volume]
 * `time` is the candle OPEN time in UTC, "YYYY-MM-DD HH:mm:ss" or ISO 8601.
 * This matches the OANDA mid-price files in github.com/FutureSharks/financial-data.
 *
 * Nothing is filled in: missing minutes stay missing, so the engine's gap checks
 * see the data exactly as the provider published it. Duplicates are dropped
 * (first wins) and counted.
 */
export function loadCandleDir(dir: string): { candles: Candle[]; files: number; duplicates: number; invalidRows: number } {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".csv") && statSync(join(dir, f)).isFile())
    .sort();
  const byTime = new Map<number, Candle>();
  let duplicates = 0;
  let invalidRows = 0;
  for (const f of files) {
    const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/);
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const col = (name: string) => {
      const i = header.indexOf(name);
      if (i === -1) throw new Error(`${f}: missing column ${name}`);
      return i;
    };
    const [it, io, ih, il, ic] = ["time", "open", "high", "low", "close"].map(col);
    for (let k = 1; k < lines.length; k++) {
      const line = lines[k];
      if (!line) continue;
      const p = line.split(",");
      const raw = p[it];
      const time = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
      const c: Candle = { time, open: +p[io], high: +p[ih], low: +p[il], close: +p[ic] };
      if (!Number.isFinite(time) || ![c.open, c.high, c.low, c.close].every(Number.isFinite)) {
        invalidRows++;
        continue;
      }
      if (byTime.has(time)) {
        duplicates++;
        continue;
      }
      byTime.set(time, c);
    }
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { candles, files: files.length, duplicates, invalidRows };
}
