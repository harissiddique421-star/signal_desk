/**
 * Re-check the SHIPPED rules on recent candles from the live provider.
 *
 *   npx tsx scripts/research/recent-test.ts --data data-recent --out src/lib/research/recent.json
 *
 * Runs exactly what the app runs:
 *   - v2 Fade through runBacktest (same engine, 300-candle window, no look-ahead,
 *     entry at the open of the next candle, expiry at its close; "late" = one candle later),
 *   - the v3 ML shadow model with the same data gate (no missing minute in the last 60).
 * Nothing is tuned here. The result is compared with the 2020 TEST numbers in
 * history.json so you can see whether the edge still exists on today's market.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBacktest } from "../../src/lib/backtest/backtest";
import { DEFAULT_RULES, RuleConfigSchema } from "../../src/lib/config/rules";
import { MODE_OVERRIDES } from "../../src/lib/config/presets";
import { shadowPredict } from "../../src/lib/ml/model";
import { summarize, type Outcome, type TradeRecord } from "../../src/lib/stats/performance";
import { inspectSeries } from "../../src/lib/validation/candles";
import type { Candle } from "../../src/lib/types";
import { loadCandleDir } from "./load-candles";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const dataDir = args.get("data") ?? "data-recent";
const outPath = args.get("out") ?? "src/lib/research/recent.json";
const payout = Number(args.get("payout") ?? 0.85);
const historyPath = args.get("history") ?? "src/lib/research/history.json";
const sourceId = args.get("source") ?? "twelvedata";
const SOURCES: Record<string, { name: string; label: string; liveFeed: boolean }> = {
  twelvedata: { name: "Twelve Data", label: "Twelve Data 1-minute candles (the feed the live app uses)", liveFeed: true },
  dukascopy: { name: "Dukascopy", label: "Dukascopy 1-minute mid candles (tick-built, history only)", liveFeed: false },
};
const SRC = SOURCES[sourceId];
if (!SRC) throw new Error(`unknown --source ${sourceId}`);
const TF = 60_000;

const SESSIONS: [number, number, string][] = [
  [0, 7, "Asia 00-07"],
  [7, 12, "London 07-12"],
  [12, 16, "London/NY 12-16"],
  [16, 21, "New York 16-21"],
  [21, 24, "Rollover 21-24"],
];
const sessionOf = (t: number) => {
  const h = new Date(t).getUTCHours();
  return SESSIONS.find(([a, b]) => h >= a && h < b)![2];
};

interface Trade {
  pair: string;
  time: number;
  outcome: Outcome;
  late: Outcome;
}

const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);

function stat(trades: Trade[], which: "outcome" | "late" = "outcome") {
  const recs: TradeRecord[] = trades.map((t) => ({ time: t.time, outcome: t[which] }));
  const s = summarize(recs, payout);
  return {
    n: s.wins + s.losses,
    signals: trades.length,
    winRate: r4(s.winRate),
    ci95: s.winRateCi95 ? (s.winRateCi95.map((x) => r4(x)) as [number, number]) : null,
    net: Math.round(s.netUnits * 100) / 100,
    maxLosingStreak: s.maxLosingStreak,
    maxDrawdown: Math.round(s.maxDrawdownUnits * 100) / 100,
  };
}

function outcomeOf(dir: "CALL" | "PUT", from: number, to: number): Outcome {
  if (to === from) return "TIE";
  return (dir === "CALL") === to > from ? "WIN" : "LOSS";
}

/** v3 shadow decisions on every eligible minute, scored like v2. */
function v3Trades(pair: string, candles: Candle[]): Trade[] {
  const out: Trade[] = [];
  for (let i = 299; i < candles.length - 1; i++) {
    const win = candles.slice(i - 299, i + 1);
    if (inspectSeries(win, TF, 60).missing.length > 0) continue;
    const next = candles[i + 1];
    if (next.time !== candles[i].time + TF) continue;
    const p = shadowPredict(win, pair);
    if (!p || p.decision === "NO_TRADE") continue;
    const after = candles[i + 2];
    out.push({
      pair,
      time: candles[i].time,
      outcome: outcomeOf(p.decision, next.open, next.close),
      late: after && after.time === next.time + TF ? outcomeOf(p.decision, next.close, after.close) : "UNRESOLVED",
    });
  }
  return out;
}

/** Two-sided z-test for a difference between two win rates (pooled). */
function compare(a: { n: number; winRate: number | null }, b: { n: number; winRate: number | null }) {
  if (!a.n || !b.n || a.winRate === null || b.winRate === null) return null;
  const p = (a.winRate * a.n + b.winRate * b.n) / (a.n + b.n);
  const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  const z = se > 0 ? (a.winRate - b.winRate) / se : 0;
  // normal CDF via erf approximation (Abramowitz–Stegun 7.1.26)
  const erf = (x: number) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  const pValue = 1 - erf(Math.abs(z) / Math.SQRT2);
  return { diff: r4(a.winRate - b.winRate), z: Math.round(z * 100) / 100, pValue: r4(pValue) };
}

const isWeekend = (t: number) => {
  const d = new Date(t);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day === 6 || (day === 5 && h >= 21) || (day === 0 && h < 21);
};
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

/**
 * How this feed builds its candles. The outcome rule assumes the next candle opens
 * where the signal candle closed (a continuous price series). If a feed's "open" is
 * taken from a different moment, "open → close of the next candle" no longer measures
 * what a trader entering at the start of the minute would get.
 */
function feedCheck(candles: Candle[], trades: { signalCandleTime: number; decision: "CALL" | "PUT" }[]) {
  const byTime = new Map(candles.map((c, i) => [c.time, i]));
  let pairs = 0, continuous = 0, flat = 0, weekend = 0, openEqPrevOpen = 0, openInPrevRange = 0, closeEqNextOpenOfNext = 0;
  let sGB = 0, sBB = 0; // regression of gap on the previous candle's body (weekdays)
  const gapRel: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.high === c.low) flat++;
    if (isWeekend(c.time)) weekend++;
    const n = candles[i + 1];
    if (!n || n.time !== c.time + TF || isWeekend(c.time)) continue;
    pairs++;
    const gapSigned = n.open - c.close;
    const gap = Math.abs(gapSigned);
    if (gap < 1e-9) continuous++;
    if (Math.abs(n.open - c.open) < 1e-9) openEqPrevOpen++;
    if (n.open >= c.low && n.open <= c.high) openInPrevRange++;
    const nn = candles[i + 2];
    if (nn && nn.time === n.time + TF && Math.abs(c.close - nn.open) < 1e-9) closeEqNextOpenOfNext++;
    const body = c.close - c.open;
    sGB += gapSigned * body;
    sBB += body * body;
    const range = c.high - c.low;
    if (range > 0) gapRel.push(gap / range);
  }
  // For v2 trades: does the gap between signal close and next open run WITH the signal candle?
  let gapWith = 0, gapAgainst = 0, gapZero = 0;
  const closeEntry: Outcome[] = [];
  for (const t of trades) {
    const i = byTime.get(t.signalCandleTime);
    if (i === undefined) continue;
    const c = candles[i], n = candles[i + 1];
    if (!n || n.time !== c.time + TF || isWeekend(c.time)) continue;
    const dirSignal = Math.sign(c.close - c.open);
    const g = Math.sign(n.open - c.close);
    if (g === 0) gapZero++;
    else if (g === dirSignal) gapWith++;
    else gapAgainst++;
    // Alternative entry: at the signal candle's close (what a continuous feed would give).
    closeEntry.push(outcomeOf(t.decision, c.close, n.close));
  }
  const ce = summarize(closeEntry.map((o, k) => ({ time: k, outcome: o })), payout);
  return {
    weekendCandles: weekend,
    flatCandleShare: r4(flat / candles.length),
    continuousOpenShare: pairs ? r4(continuous / pairs) : null,
    // weekday minutes only from here
    openEqualsPrevOpenShare: pairs ? r4(openEqPrevOpen / pairs) : null,
    openInsidePrevRangeShare: pairs ? r4(openInPrevRange / pairs) : null,
    closeEqualsOpenTwoAheadShare: pairs ? r4(closeEqNextOpenOfNext / pairs) : null,
    /** gap(next open − close) ≈ slope × body(close − open). 0 = continuous feed; −1 = next open equals this open. */
    gapOnBodySlope: sBB > 0 ? r4(sGB / sBB) : null,
    medianGapToRange: r4(median(gapRel)),
    v2GapWithSignal: gapWith,
    v2GapAgainstSignal: gapAgainst,
    v2GapZero: gapZero,
    v2EntryAtSignalClose: { n: ce.wins + ce.losses, winRate: r4(ce.winRate), ci95: ce.winRateCi95?.map((x) => r4(x)) ?? null },
  };
}

const MIN_TRADES = 200;
function verdict(s: { n: number; winRate: number | null; ci95: [number, number] | null }, be: number) {
  if (s.n < MIN_TRADES) return { code: "TOO_FEW", text: `Sirf ${s.n} trades — kam az kam ${MIN_TRADES} chahiye. Abhi faisla nahin ho sakta.` };
  if (!s.ci95) return { code: "TOO_FEW", text: "Koi trade nahin." };
  if (s.ci95[0] > be) return { code: "EDGE", text: "Naye data par bhi jeet break-even se pakke taur par zyada hai." };
  if (s.ci95[1] < be) return { code: "LOSING", text: "Naye data par yeh version break-even se pakke taur par neeche hai — is par paisa na lagayein." };
  return { code: "UNPROVEN", text: "Naye data par pakka faida sabit nahin hota (95% range mein break-even shamil hai)." };
}

function main() {
  if (!existsSync(dataDir)) throw new Error(`no data folder ${dataDir}`);
  const pairDirs = readdirSync(dataDir).filter((d) => statSync(join(dataDir, d)).isDirectory()).sort();
  const v2Cfg = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.V2 });
  const be = 1 / (1 + payout);
  const v2All: Trade[] = [];
  const v3All: Trade[] = [];
  const data: Record<string, unknown> = {};
  let first = Infinity;
  let last = -Infinity;
  let opportunities = 0;

  for (const dir of pairDirs) {
    const pair = dir.replace("_", "/");
    const { candles, duplicates, invalidRows } = loadCandleDir(join(dataDir, dir));
    if (candles.length < 400) {
      data[pair] = { candles: candles.length, skipped: "fewer than 400 candles" };
      continue;
    }
    first = Math.min(first, candles[0].time);
    last = Math.max(last, candles[candles.length - 1].time);
    const span = Math.round((candles[candles.length - 1].time - candles[0].time) / TF) + 1;
    const res = runBacktest({
      candles,
      symbol: pair,
      marketType: "LIVE",
      source: { id: sourceId, name: SRC.name, verified: true, supportedMarketTypes: ["LIVE"] },
      payout,
      inSampleFraction: 1,
      config: v2Cfg,
    });
    opportunities += res.barsEvaluated;
    const v2 = res.trades.map((t) => ({ pair, time: t.signalCandleTime, outcome: t.outcome, late: t.lateOutcome }));
    const v3 = v3Trades(pair, candles);
    v2All.push(...v2);
    v3All.push(...v3);
    data[pair] = {
      candles: candles.length,
      minutesSpanned: span,
      duplicates,
      invalidRows,
      first: new Date(candles[0].time).toISOString(),
      last: new Date(candles[candles.length - 1].time).toISOString(),
      feed: feedCheck(candles, res.trades),
    };
    console.error(`${pair}: ${candles.length} candles, v2 ${v2.length} signals, v3 ${v3.length} signals`);
  }

  const by = (trades: Trade[], key: (t: Trade) => string) => {
    const groups = new Map<string, Trade[]>();
    for (const t of trades) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
    return Object.fromEntries([...groups.entries()].sort().map(([k, v]) => [k, stat(v)]));
  };

  const history = JSON.parse(readFileSync(historyPath, "utf8")) as { versions: { id: string; test: { n: number; winRate: number | null; ci95: [number, number] } }[] };
  const hist = (id: string) => history.versions.find((v) => v.id === id)?.test ?? null;

  const v2 = stat(v2All);
  const v3 = stat(v3All);
  const result = {
    generatedAt: new Date().toISOString(),
    sourceId,
    source: SRC.label,
    liveFeed: SRC.liveFeed,
    period: Number.isFinite(first) ? { from: new Date(first).toISOString(), to: new Date(last).toISOString() } : null,
    payout,
    breakEven: r4(be),
    opportunities,
    minTradesForVerdict: MIN_TRADES,
    outcomeRule: "Same as the app: entry = open of the candle after the signal candle, expiry = its close; late = one full candle later. Ties refund and are excluded.",
    data,
    v2: {
      onTime: v2,
      late: stat(v2All, "late"),
      verdict: verdict(v2, be),
      vsHistoricalTest: hist("v2") ? { historical: hist("v2"), ...compare(v2, hist("v2")!) } : null,
      byPair: by(v2All, (t) => t.pair),
      bySession: by(v2All, (t) => sessionOf(t.time)),
      byWeekPart: by(v2All, (t) => (isWeekend(t.time) ? "weekend (market closed)" : "weekday")),
    },
    v3: {
      onTime: v3,
      late: stat(v3All, "late"),
      verdict: verdict(v3, be),
      vsV2: compare(v3, v2),
      byPair: by(v3All, (t) => t.pair),
    },
  };
  writeFileSync(outPath, JSON.stringify(result, null, 1) + "\n");
  console.error(`v2: ${v2.n} decided, win ${v2.winRate} ${JSON.stringify(v2.ci95)} → ${result.v2.verdict.code}`);
  console.error(`v3: ${v3.n} decided, win ${v3.winRate} ${JSON.stringify(v3.ci95)} → ${result.v3.verdict.code}`);
}

main();
