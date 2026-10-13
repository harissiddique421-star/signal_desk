/**
 * Run the SHIPPED TypeScript v3 shadow model over historical candles, the same
 * way the app does (300-candle window, closed candles only, data gates), so its
 * numbers can be checked against the Python research result.
 *
 *   npx tsx scripts/research/shadow-ledger.ts --data data --pair EUR_USD --from 2020-01-01 --out research-out/v3
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shadowPredict } from "../../src/lib/ml/model";
import { inspectSeries } from "../../src/lib/validation/candles";
import { loadCandleDir } from "./load-candles";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const dataDir = args.get("data")!;
const pair = args.get("pair")!;
const from = Date.parse(args.get("from") ?? "2020-01-01T00:00:00Z");
const outDir = args.get("out") ?? "research-out/v3";
const TF = 60_000;

const { candles } = loadCandleDir(join(dataDir, pair));
const rows = ["time,d_V3,p"];
for (let i = 299; i < candles.length; i++) {
  if (candles[i].time < from) continue;
  const win = candles.slice(i - 299, i + 1);
  // same data gate as the engine: no missing minute in the last 60
  if (inspectSeries(win, TF, 60).missing.length > 0) continue;
  const p = shadowPredict(win, pair.replace("_", "/"));
  if (!p) continue;
  rows.push(`${candles[i].time},${p.decision === "CALL" ? 1 : p.decision === "PUT" ? -1 : 0},${p.probability.toFixed(5)}`);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `shadow-${pair}.csv`), rows.join("\n") + "\n");
console.error(`${pair}: ${rows.length - 1} rows`);
