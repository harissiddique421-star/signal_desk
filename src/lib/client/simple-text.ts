import type { Check, Evidence, SignalResult } from "../types";

/** Plain Roman Urdu reasons for the simple screen. */
const CHECK_TEXT: Record<string, string> = {
  "source.verified": "Live data connected nahin (sirf sample data).",
  "source.marketType": "OTC ka live data kisi jaiz source se mojood nahin.",
  "source.symbol": "Yeh pair is data source mein nahin.",
  "data.count": "Kaafi candles ka data nahin mila.",
  "data.ohlc": "Data mein ghalat candles hain.",
  "data.timestamps": "Candles ka waqt theek nahin.",
  "data.gaps": "Data mein candles missing hain.",
  "data.freshness": "Taaza candle abhi nahin aayi.",
  "data.warmup": "Indicators ke liye data kam hai.",
  "vol.shock": "Abhi bahut bari candle bani hai — khatra zyada.",
  "news.available": "News filter mojood nahin.",
  "news.clear": "Bari news aa rahi hai — khatra.",
  "decision.agreement": "Indicators ek taraf nahin — market confused hai.",
  "decision.support": "Kaafi indicators saath nahin de rahe.",
  "decision.trend": "Trend saaf nahin.",
  "decision.structure": "Market structure ulti taraf hai.",
  "decision.mtf": "5-minute chart ulti taraf ja raha hai.",
  "decision.rsiExtreme": "RSI hadd par hai — move thak chuka hai.",
  "decision.doji": "Aakhri candle doji hai — market ne faisla nahin kiya.",
  "decision.level": "Saamne support/resistance bilkul qareeb hai.",
  "timing.window": "Entry ka waqt nikal gaya — agli candle ka intezar.",
};

export function waitReason(r: SignalResult): string {
  const failed = r.checks.filter((c) => !c.passed);
  const first = failed.find((c) => c.id !== "source.verified") ?? failed[0];
  if (!first) return "Koi saaf signal nahin.";
  if (first.id === "vol.atrRange") return /quiet/.test(first.detail) ? "Market bohat sust hai — move nahin ho rahi." : "Market bohat tez hai — khatra zyada.";
  return CHECK_TEXT[first.id] ?? first.detail;
}

export function onlyTimingFailed(checks: Check[]): boolean {
  const failed = checks.filter((c) => !c.passed);
  return failed.length > 0 && failed.every((c) => c.id === "timing.window");
}

const SHORT: Record<string, string> = {
  "trend.ema": "Trend",
  "trend.slope": "EMA slope",
  "structure.swings": "Structure",
  "momentum.macd": "MACD",
  "momentum.rsi": "RSI",
  "bands.position": "Bollinger",
  "mtf.trend": "5-min trend",
};

export function evidenceChips(evidence: Evidence[], dir: "BULLISH" | "BEARISH") {
  return evidence
    .filter((e) => e.direction === dir)
    .map((e) => SHORT[e.id] ?? e.label.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));
}

export function agreementCount(r: SignalResult): { agree: number; total: number; dir: "BULLISH" | "BEARISH" } {
  const dir = r.agreementScore >= 0 ? "BULLISH" : "BEARISH";
  return { agree: r.evidence.filter((e) => e.direction === dir).length, total: r.evidence.length, dir };
}
