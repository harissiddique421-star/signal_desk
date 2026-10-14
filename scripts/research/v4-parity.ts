/**
 * Check that the app's TypeScript engine (mode V4) reproduces the Python search
 * result for the chosen v4 rule on the same Dukascopy candles (TEST period).
 *
 *   npx tsx scripts/research/v4-parity.ts --data data-search --from 2026-04-01 --expect src/lib/research/strategy-search.json
 *
 * Prints per-pair and total decided trades / win rate for both, and a GitHub
 * annotation so the comparison is visible without the job log.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runBacktest } from "../../src/lib/backtest/backtest";
import { DEFAULT_RULES, RuleConfigSchema } from "../../src/lib/config/rules";
import { MODE_OVERRIDES } from "../../src/lib/config/presets";
import { loadCandleDir } from "./load-candles";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const dataDir = args.get("data") ?? "data-search";
const from = Date.parse(`${args.get("from") ?? "2026-04-01"}T00:00:00Z`);
const expectPath = args.get("expect") ?? "src/lib/research/strategy-search.json";
const cfg = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.V4 });
const search = JSON.parse(readFileSync(expectPath, "utf8")) as { chosen: { test: { n: number; winRate: number }; testByPair: Record<string, { n: number; winRate: number }> } };

let W = 0, L = 0;
const lines: string[] = [];
for (const pair of Object.keys(search.chosen.testByPair)) {
  const { candles } = loadCandleDir(join(dataDir, pair.replace("/", "_")));
  // keep 600 candles of warm-up before the TEST period
  const startIdx = Math.max(0, candles.findIndex((c) => c.time >= from) - 600);
  const res = runBacktest({ candles: candles.slice(startIdx), symbol: pair, marketType: "LIVE", source: { id: "dukascopy", name: "Dukascopy", verified: true, supportedMarketTypes: ["LIVE"] }, payout: 0.9, inSampleFraction: 1, config: cfg });
  const t = res.trades.filter((x) => x.signalCandleTime >= from);
  const w = t.filter((x) => x.outcome === "WIN").length;
  const l = t.filter((x) => x.outcome === "LOSS").length;
  W += w;
  L += l;
  const py = search.chosen.testByPair[pair];
  lines.push(`${pair}: TS ${w + l} trades ${((w / Math.max(1, w + l)) * 100).toFixed(1)}% | Python ${py.n} trades ${(py.winRate * 100).toFixed(1)}%`);
}
const total = `TOTAL: TS ${W + L} trades ${((W / Math.max(1, W + L)) * 100).toFixed(2)}% | Python ${search.chosen.test.n} trades ${(search.chosen.test.winRate * 100).toFixed(2)}%`;
console.log([...lines, total].join("\n"));
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=v4 parity::${[...lines, total].join(" ; ")}`);
