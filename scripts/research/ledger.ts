/**
 * Build a per-minute research ledger by running the REAL signal engine over
 * historical 1-minute candles, exactly as the live app would at each minute.
 *
 *   npx tsx scripts/research/ledger.ts --data <dir-with-pair-folders> --pair EUR_USD --out research-out
 *
 * For every closed candle i (the "signal candle") the engine sees only candles
 * up to and including i, evaluated 1 s after i closed (no look-ahead). The ledger
 * then records, for the direction the evidence leaned to:
 *   r1  = sign(close - open) of candle i+1  → on-time result (entry at the open
 *         of the next candle, expiry at its close — what the app's tracker assumes)
 *   rl  = sign(close[i+2] - close[i+1])      → one-candle-late result (entry a full
 *         minute late; a pessimistic bound for slow manual entry)
 *   r2  = sign(close - open) of candle i+2  → what the old Generate button targeted
 * Missing next candles are written as blank, never guessed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RULES, RuleConfigSchema, type RuleConfig } from "../../src/lib/config/rules";
import { MODE_OVERRIDES, type SignalMode } from "../../src/lib/config/presets";
import { evaluateSignal } from "../../src/lib/engine/signal";
import type { Candle } from "../../src/lib/types";
import { loadCandleDir } from "./load-candles";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const dataDir = args.get("data");
const pair = args.get("pair");
const outDir = args.get("out") ?? "research-out";
const modes = (args.get("modes") ?? Object.keys(MODE_OVERRIDES).join(",")).split(",") as SignalMode[];
const WINDOW = Number(args.get("window") ?? 300); // live analysis fetches 300 candles
if (!dataDir || !pair) {
  console.error("usage: ledger.ts --data DIR --pair EUR_USD [--out research-out] [--modes STRICT,NORMAL]");
  process.exit(2);
}

const configs: Record<string, RuleConfig> = {};
for (const m of modes) {
  if (!(m in MODE_OVERRIDES)) throw new Error(`unknown mode ${m}`);
  configs[m] = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES[m] });
}

const { candles, files, duplicates, invalidRows } = loadCandleDir(join(dataDir, pair));
const symbol = pair.replace("_", "/");
const source = { id: "history", name: "Historical OANDA mid candles", verified: true, supportedMarketTypes: ["LIVE" as const] };
const TF = 60_000;
const EVID = ["trend.ema", "trend.slope", "structure.swings", "momentum.macd", "momentum.rsi", "bands.position", "mtf.trend"];
const dirNum = (d: string | undefined) => (d === "BULLISH" ? 1 : d === "BEARISH" ? -1 : 0);
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const decNum = (d: string) => (d === "CALL" ? 1 : d === "PUT" ? -1 : 0);

const header = [
  "time", "want", "agree", "support", "nev",
  ...modes.flatMap((m) => [`d_${m}`, `fail_${m}`]),
  ...EVID.map((e) => `e_${e.split(".")[1]}`),
  "patterns", "breakouts",
  "atrPct", "rangeAtr", "body", "lastDir", "rsi", "pb", "regime", "oppAtr", "structure",
  "r1", "rl", "r2",
];
const rows: string[] = [header.join(",")];
const started = Date.now();
let lastLog = started;

for (let i = DEFAULT_RULES.minCandles - 1; i < candles.length - 1; i++) {
  const slice = candles.slice(Math.max(0, i - WINDOW + 1), i + 1);
  const now = candles[i].time + TF + 1000;
  const results = modes.map((m) =>
    evaluateSignal({ candles: slice, symbol, marketType: "LIVE", symbolSupported: true, source, analysisKind: "LIVE_FEED", now, config: configs[m] }),
  );
  const r = results[0];
  // Data gates failed (gap, stale, warm-up): the live app would show NO TRADE; keep the row only for counts.
  const m = r.metrics;
  const c1: Candle | undefined = candles[i + 1]?.time === candles[i].time + TF ? candles[i + 1] : undefined;
  const c2: Candle | undefined = c1 && candles[i + 2]?.time === c1.time + TF ? candles[i + 2] : undefined;
  const want = sign(r.agreementScore);
  const evDir = new Map(r.evidence.map((e) => [e.id, e.direction]));
  const patterns = r.evidence.filter((e) => e.id.startsWith("pattern.")).map((e) => e.id.slice(8)).join("|");
  const breakouts = r.evidence.filter((e) => e.id.startsWith("breakout.")).map((e) => e.id.slice(9)).join("|");
  rows.push(
    [
      candles[i].time,
      want,
      r.agreementScore,
      r.evidence.filter((e) => dirNum(e.direction) === want && want !== 0).length,
      r.evidence.length,
      ...results.flatMap((x) => [decNum(x.decision), x.checks.filter((c) => !c.passed).map((c) => c.id).join("|")]),
      ...EVID.map((e) => dirNum(evDir.get(e))),
      patterns,
      breakouts,
      m ? m.atrPercentile : "",
      m ? m.lastRangeAtr : "",
      m ? m.bodyRatio : "",
      m ? m.lastCandleDir : "",
      m ? m.rsi : "",
      m ? m.bbPercentB : "",
      m ? m.regime : "",
      m && m.opposingLevelAtr !== null ? m.opposingLevelAtr : "",
      m ? m.structure : "",
      c1 ? sign(c1.close - c1.open) : "",
      c1 && c2 ? sign(c2.close - c1.close) : "",
      c2 ? sign(c2.close - c2.open) : "",
    ].join(","),
  );
  if (Date.now() - lastLog > 30_000) {
    lastLog = Date.now();
    console.error(`${pair}: ${i}/${candles.length} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `ledger-${pair}.csv`), rows.join("\n") + "\n");
writeFileSync(
  join(outDir, `ledger-${pair}.meta.json`),
  JSON.stringify({ pair, files, candles: candles.length, duplicates, invalidRows, first: candles[0]?.time, last: candles.at(-1)?.time, window: WINDOW, modes, ruleVersion: DEFAULT_RULES.version, seconds: Math.round((Date.now() - started) / 1000) }, null, 2),
);
console.error(`${pair}: done, ${rows.length - 1} rows in ${Math.round((Date.now() - started) / 1000)}s`);
