import type { RuleConfig } from "../config/rules";
import { DEFAULT_RULES } from "../config/rules";
import { atr, bollinger, ema, macd, percentileRank, rsi } from "../indicators";
import type { AnalysisKind, Candle, Check, Decision, Direction, Evidence, MarketType, SignalResult } from "../types";
import { checkFreshness, closedCandlesOnly, inspectSeries } from "../validation/candles";
import { anatomy, detectPatterns } from "../analysis/candles";
import { buildZones, detectBreakouts, findSwings, marketStructure, nearestZones, resample } from "../analysis/structure";

export interface SourceInfo {
  id: string;
  name: string;
  /** True only for a configured, permitted, real market-data provider */
  verified: boolean;
  supportedMarketTypes: MarketType[];
}

export interface NewsContext {
  /** A verified economic-calendar provider is configured and answered */
  available: boolean;
  /** High-impact events inside the blackout window, if any */
  blockingEvents: string[];
}

export interface EngineInput {
  candles: Candle[];
  symbol: string;
  displaySymbol?: string;
  marketType: MarketType;
  symbolSupported: boolean;
  source: SourceInfo;
  analysisKind: AnalysisKind;
  now: number;
  config?: RuleConfig;
  news?: NewsContext;
}

const UR = {
  noData: "Data mukammal ya taaza nahin — is liye koi trade nahin.",
};

/**
 * Evaluate the latest CLOSED 1-minute candle and return CALL / PUT / NO_TRADE.
 * Pure function: same input → same output. Only candles closed at `now` are used.
 */
export function evaluateSignal(input: EngineInput): SignalResult {
  const cfg = input.config ?? DEFAULT_RULES;
  const tfMs = cfg.timeframeSeconds * 1000;
  const checks: Check[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const evidence: Evidence[] = [];

  const base: SignalResult = {
    decision: "NO_TRADE",
    engineDecision: "NO_TRADE",
    analysisKind: input.analysisKind,
    symbol: input.symbol,
    displaySymbol: input.displaySymbol ?? input.symbol,
    marketType: input.marketType,
    source: input.source.name,
    sourceVerified: input.source.verified,
    analyzedAt: input.now,
    signalCandleTime: null,
    entryReference: null,
    entryWindowStart: null,
    entryWindowEnd: null,
    expirySeconds: cfg.expirySeconds,
    checks,
    evidence,
    reasons,
    warnings,
    agreementScore: 0,
    bullishWeight: 0,
    bearishWeight: 0,
    ruleVersion: cfg.version,
  };

  const addCheck = (id: string, label: string, passed: boolean, detail: string) => {
    checks.push({ id, label, passed, detail });
    if (!passed) reasons.push(`${label}: ${detail}`);
    return passed;
  };

  // ---- 1. Source / symbol / market-type gates --------------------------------
  addCheck(
    "source.verified",
    "Source",
    input.source.verified,
    input.source.verified ? `${input.source.name} (verified provider)` : `${input.source.name} is not a verified live market feed`,
  );
  const mtOk = input.source.supportedMarketTypes.includes(input.marketType);
  addCheck(
    "source.marketType",
    "Market type",
    mtOk,
    mtOk
      ? `${input.marketType} supported by ${input.source.name}`
      : input.marketType === "OTC"
        ? `No verified data source for broker OTC prices; ${input.source.name} does not represent OTC quotes`
        : `${input.source.name} does not provide ${input.marketType} data`,
  );
  if (!mtOk) return finalize(base, input, warnings);
  addCheck("source.symbol", "Symbol", input.symbolSupported, input.symbolSupported ? `${base.displaySymbol} supported` : `${input.symbol} is not offered by ${input.source.name}`);
  if (!input.symbolSupported) return finalize(base, input, warnings);

  // ---- 2. Data quality gates --------------------------------------------------
  const closed = closedCandlesOnly(input.candles, tfMs, input.now);
  const dropped = input.candles.length - closed.length;
  if (dropped > 0) warnings.push(`${dropped} unfinished candle(s) ignored to avoid look-ahead`);

  if (!addCheck("data.count", "Candle history", closed.length >= cfg.minCandles, `${closed.length} closed candles (need ${cfg.minCandles})`)) {
    return finalize(base, input, warnings);
  }

  const report = inspectSeries(closed, tfMs, cfg.gapLookback);
  addCheck(
    "data.ohlc",
    "OHLC validity",
    report.invalid.length === 0,
    report.invalid.length ? `${report.invalid.length} invalid candle(s), first: ${report.invalid[0].problem}` : "All candles pass OHLC checks",
  );
  addCheck(
    "data.timestamps",
    "Timestamps",
    !report.misaligned.length && !report.duplicates.length && !report.outOfOrder.length,
    report.misaligned.length || report.duplicates.length || report.outOfOrder.length
      ? `misaligned ${report.misaligned.length}, duplicate ${report.duplicates.length}, out-of-order ${report.outOfOrder.length}`
      : "Aligned to 1m, ascending, unique",
  );
  addCheck(
    "data.gaps",
    "Missing candles",
    report.missing.length === 0,
    report.missing.length ? `${report.missing.length} missing in last ${cfg.gapLookback} (first ${new Date(report.missing[0]).toISOString()})` : `None in last ${cfg.gapLookback}`,
  );
  const fresh = checkFreshness(closed, tfMs, input.now, cfg.maxStalenessSeconds);
  addCheck("data.freshness", "Freshness", fresh.fresh, fresh.detail);
  if (reasons.length && checks.some((c) => c.id.startsWith("data.") && !c.passed)) {
    warnings.push(UR.noData);
    return finalize(base, input, warnings);
  }

  const lastC = closed[closed.length - 1];
  base.signalCandleTime = lastC.time;
  base.entryReference = lastC.close;
  base.entryWindowStart = lastC.time + tfMs;
  base.entryWindowEnd = base.entryWindowStart + cfg.entryWindowSeconds * 1000;
  const windowOpen = input.now <= base.entryWindowEnd;

  // ---- 3. Indicators (computed on closed candles only) ------------------------
  const closes = closed.map((c) => c.close);
  const eFast = ema(closes, cfg.emaFast);
  const eSlow = ema(closes, cfg.emaSlow);
  const eTrend = ema(closes, cfg.emaTrend);
  const r = rsi(closes, cfg.rsiPeriod);
  const m = macd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const bb = bollinger(closes, cfg.bbPeriod, cfg.bbStdDev);
  const a = atr(closed, cfg.atrPeriod);
  const i = closed.length - 1;
  const atrNow = a[i];
  const atrPrev = a[i - 1];
  if (atrNow === null || atrPrev === null || eTrend[i] === null || m.histogram[i] === null || m.histogram[i - 1] === null || r[i] === null || bb.middle[i] === null) {
    addCheck("data.warmup", "Indicator warm-up", false, "Not enough history for all indicators");
    return finalize(base, input, warnings);
  }

  // ---- 4. Volatility filters --------------------------------------------------
  const atrSample = (a.slice(-cfg.volatilityWindow).filter((x) => x !== null) as number[]);
  const atrPct = percentileRank(atrSample, atrNow);
  addCheck(
    "vol.atrRange",
    "Volatility",
    atrPct >= cfg.minAtrPercentile && atrPct <= cfg.maxAtrPercentile,
    `ATR percentile ${atrPct.toFixed(0)} (allowed ${cfg.minAtrPercentile}–${cfg.maxAtrPercentile})${atrPct < cfg.minAtrPercentile ? " — market too quiet" : atrPct > cfg.maxAtrPercentile ? " — volatility spike" : ""}`,
  );
  const lastRange = lastC.high - lastC.low;
  addCheck(
    "vol.shock",
    "Shock candle",
    lastRange <= cfg.shockCandleAtr * atrPrev,
    `Last range ${(lastRange / atrPrev).toFixed(2)}× ATR (limit ${cfg.shockCandleAtr}×)`,
  );

  // ---- 5. News filter ---------------------------------------------------------
  const news = input.news ?? { available: false, blockingEvents: [] };
  if (!news.available) {
    const msg = "No verified economic-calendar provider configured; news risk not checked";
    if (cfg.requireNewsFilter) addCheck("news.available", "News filter", false, msg);
    else warnings.push(msg);
  } else {
    addCheck("news.clear", "News filter", news.blockingEvents.length === 0, news.blockingEvents.length ? `High-impact event: ${news.blockingEvents.join(", ")}` : "No high-impact events in window");
  }

  // ---- 6. Evidence ------------------------------------------------------------
  const push = (e: Evidence) => evidence.push(e);
  const f = eFast[i] as number;
  const s = eSlow[i] as number;
  const t = eTrend[i] as number;
  const close = lastC.close;

  const emaDir: Direction = f > s && close > t ? "BULLISH" : f < s && close < t ? "BEARISH" : "NEUTRAL";
  push({
    id: "trend.ema",
    module: "Trend",
    label: `EMA ${cfg.emaFast}/${cfg.emaSlow} + EMA ${cfg.emaTrend}`,
    direction: emaDir,
    weight: 2,
    detail: `EMA${cfg.emaFast} ${fmt(f)} ${f > s ? ">" : "<"} EMA${cfg.emaSlow} ${fmt(s)}; close ${close > t ? "above" : "below"} EMA${cfg.emaTrend}`,
    detailUr:
      emaDir === "BULLISH" ? "Tez EMA dheemi EMA se upar hai aur price trend line se upar — rujhan upar ki taraf." : emaDir === "BEARISH" ? "Tez EMA dheemi EMA se neeche hai aur price trend line se neeche — rujhan neeche ki taraf." : "EMA aapas mein mutafiq nahin — rujhan wazeh nahin.",
  });

  const slowPrev = eSlow[i - 3];
  const slopeDir: Direction = slowPrev === null ? "NEUTRAL" : s > slowPrev ? "BULLISH" : s < slowPrev ? "BEARISH" : "NEUTRAL";
  push({ id: "trend.slope", module: "Trend", label: `EMA ${cfg.emaSlow} slope`, direction: slopeDir, weight: 1, detail: `3-bar slope ${slowPrev === null ? "n/a" : fmt(s - slowPrev)}`, detailUr: "Dheemi EMA ka jhukao (slope)." });

  const structureWindow = closed.slice(-cfg.levelLookback);
  const swings = findSwings(structureWindow, cfg.swingStrength);
  const ms = marketStructure(swings);
  const msDir: Direction = ms.state === "UPTREND" ? "BULLISH" : ms.state === "DOWNTREND" ? "BEARISH" : "NEUTRAL";
  push({
    id: "structure.swings",
    module: "Market structure",
    label: `Structure: ${ms.state}`,
    direction: msDir,
    weight: 2,
    detail: ms.detail,
    detailUr: msDir === "BULLISH" ? "Unchi chotiyan aur unchi talehti — market structure upar." : msDir === "BEARISH" ? "Neechi chotiyan aur neechi talehti — market structure neeche." : "Structure range ya ghair-wazeh hai.",
  });

  const h = m.histogram[i] as number;
  const hPrev = m.histogram[i - 1] as number;
  const macdDir: Direction = h > 0 && h >= hPrev ? "BULLISH" : h < 0 && h <= hPrev ? "BEARISH" : "NEUTRAL";
  push({ id: "momentum.macd", module: "Momentum", label: "MACD histogram", direction: macdDir, weight: 1, detail: `hist ${fmt(h)} (prev ${fmt(hPrev)})`, detailUr: "MACD momentum ki taaqat aur simt batata hai." });

  const rv = r[i] as number;
  const rsiDir: Direction = rv > 50 && rv < cfg.rsiOverbought ? "BULLISH" : rv < 50 && rv > cfg.rsiOversold ? "BEARISH" : "NEUTRAL";
  push({ id: "momentum.rsi", module: "Momentum", label: `RSI ${cfg.rsiPeriod}`, direction: rsiDir, weight: 1, detail: `RSI ${rv.toFixed(1)}`, detailUr: rv >= cfg.rsiOverbought ? "RSI overbought — upar jaane ki gunjaish kam." : rv <= cfg.rsiOversold ? "RSI oversold — neeche jaane ki gunjaish kam." : "RSI 50 ke upar/neeche momentum ki simt dikhata hai." });
  if (rv >= cfg.rsiOverbought) warnings.push(`RSI overbought (${rv.toFixed(1)})`);
  if (rv <= cfg.rsiOversold) warnings.push(`RSI oversold (${rv.toFixed(1)})`);

  const mid = bb.middle[i] as number;
  const pb = bb.percentB[i] as number;
  const bbDir: Direction = close > mid ? "BULLISH" : close < mid ? "BEARISH" : "NEUTRAL";
  push({ id: "bands.position", module: "Bollinger Bands", label: "Close vs middle band", direction: bbDir, weight: 0.5, detail: `%B ${pb.toFixed(2)}`, detailUr: "Price Bollinger ke darmiyani band ke upar ya neeche." });
  if (pb > 1 || pb < 0) warnings.push(`Close outside Bollinger Bands (%B ${pb.toFixed(2)}) — stretched move`);

  const an = anatomy(lastC);
  const patterns = detectPatterns(closed.slice(-3));
  for (const p of patterns) {
    push({ id: `pattern.${p.name}`, module: "Candlestick pattern", label: p.name.replaceAll("_", " "), direction: p.direction, weight: p.direction === "NEUTRAL" ? 0.5 : 1.5, detail: `body ${(an.bodyRatio * 100).toFixed(0)}% of range, upper wick ${(an.upperWickRatio * 100).toFixed(0)}%, lower wick ${(an.lowerWickRatio * 100).toFixed(0)}%` });
  }

  for (const b of detectBreakouts(closed, 20, 5)) {
    const dir: Direction = b.kind === "BULLISH_BREAKOUT" || b.kind === "BULLISH_RETEST" || b.kind === "FALSE_BREAKOUT_DOWN" ? "BULLISH" : "BEARISH";
    push({ id: `breakout.${b.kind}`, module: "Breakout / retest", label: b.kind.replaceAll("_", " "), direction: dir, weight: b.kind.includes("RETEST") ? 2 : 1.5, detail: `${b.detail} @ ${fmt(b.level)}`, detailUr: b.kind.startsWith("FALSE") ? "Jhoota breakout — price level se bahar gayi magar wapas andar band hui." : "Level toota ya dobara test hua." });
  }

  const htf = resample(closed, cfg.mtfMinutes);
  const htfCloses = htf.map((c) => c.close);
  const hf = ema(htfCloses, cfg.emaFast);
  const hs = ema(htfCloses, cfg.emaSlow);
  const hj = htf.length - 1;
  let mtfDir: Direction = "NEUTRAL";
  if (hj >= 0 && hf[hj] !== null && hs[hj] !== null) {
    mtfDir = (hf[hj] as number) > (hs[hj] as number) ? "BULLISH" : (hf[hj] as number) < (hs[hj] as number) ? "BEARISH" : "NEUTRAL";
    push({ id: "mtf.trend", module: "Multi-timeframe", label: `${cfg.mtfMinutes}m EMA ${cfg.emaFast}/${cfg.emaSlow}`, direction: mtfDir, weight: 2, detail: `${htf.length} complete ${cfg.mtfMinutes}m bars`, detailUr: "Bare timeframe ka rujhan bhi isi simt mein hona chahiye." });
  } else {
    warnings.push(`Not enough complete ${cfg.mtfMinutes}m bars for multi-timeframe confirmation`);
  }

  // ---- 7. Score ---------------------------------------------------------------
  let bull = 0;
  let bear = 0;
  let neutral = 0;
  for (const e of evidence) {
    if (e.direction === "BULLISH") bull += e.weight;
    else if (e.direction === "BEARISH") bear += e.weight;
    else neutral += e.weight;
  }
  const total = bull + bear + neutral;
  const agreement = total > 0 ? (bull - bear) / total : 0;
  base.bullishWeight = bull;
  base.bearishWeight = bear;
  base.agreementScore = round(agreement, 3);

  // ---- 8. Direction gates -----------------------------------------------------
  const want: Direction = agreement > 0 ? "BULLISH" : agreement < 0 ? "BEARISH" : "NEUTRAL";
  const supporting = evidence.filter((e) => e.direction === want).length;
  addCheck("decision.agreement", "Indicator agreement", Math.abs(agreement) >= cfg.minAgreement && want !== "NEUTRAL", `score ${agreement.toFixed(2)} (need ±${cfg.minAgreement})${Math.min(bull, bear) > 0.6 * Math.max(bull, bear) ? " — evidence contradictory" : ""}`);
  addCheck("decision.support", "Supporting evidence", supporting >= cfg.minSupportingEvidence, `${supporting} items agree (need ${cfg.minSupportingEvidence})`);
  addCheck("decision.trend", "Trend alignment", emaDir === want, `EMA trend ${emaDir.toLowerCase()} vs direction ${want.toLowerCase()}`);
  addCheck("decision.structure", "Structure not opposing", !(msDir !== "NEUTRAL" && msDir !== want), `structure ${ms.state.toLowerCase()}`);
  if (cfg.requireMtfAgreement) addCheck("decision.mtf", "Higher timeframe", mtfDir === want, `${cfg.mtfMinutes}m trend ${mtfDir.toLowerCase()}`);
  if (want === "BULLISH") addCheck("decision.rsiExtreme", "RSI not exhausted", rv < cfg.rsiOverbought, `RSI ${rv.toFixed(1)}`);
  if (want === "BEARISH") addCheck("decision.rsiExtreme", "RSI not exhausted", rv > cfg.rsiOversold, `RSI ${rv.toFixed(1)}`);
  addCheck("decision.doji", "Clear last candle", !patterns.some((p) => p.name === "DOJI"), patterns.some((p) => p.name === "DOJI") ? "Last candle is a doji (indecision)" : "Not a doji");

  const zones = buildZones(swings, close, cfg.levelMergeAtr * atrNow);
  const { support, resistance } = nearestZones(zones, close);
  const prox = cfg.levelProximityAtr * atrNow;
  if (want === "BULLISH") {
    const blocked = !!resistance && resistance.low - close <= prox;
    addCheck("decision.level", "Room to opposing level", !blocked, resistance ? `Resistance ${fmt(resistance.low)}–${fmt(resistance.high)} is ${((resistance.low - close) / atrNow).toFixed(2)} ATR away` : "No resistance zone above");
  } else if (want === "BEARISH") {
    const blocked = !!support && close - support.high <= prox;
    addCheck("decision.level", "Room to opposing level", !blocked, support ? `Support ${fmt(support.low)}–${fmt(support.high)} is ${((close - support.high) / atrNow).toFixed(2)} ATR away` : "No support zone below");
  }

  addCheck("timing.window", "Entry window", windowOpen, windowOpen ? `Act before ${new Date(base.entryWindowEnd).toISOString()}` : "Entry window already passed — signal expired");

  const passed = reasons.length === 0;
  base.engineDecision = sourceIndependentDecision(checks, want);
  if (passed) base.decision = want === "BULLISH" ? "CALL" : "PUT";
  return finalize(base, input, warnings);
}

/** Decision the rules reach ignoring only the source-verification gate. */
function sourceIndependentDecision(checks: Check[], want: Direction): Decision {
  const failed = checks.filter((c) => !c.passed && c.id !== "source.verified");
  if (failed.length || want === "NEUTRAL") return "NO_TRADE";
  return want === "BULLISH" ? "CALL" : "PUT";
}

function finalize(base: SignalResult, input: EngineInput, warnings: string[]): SignalResult {
  // A signal is only tradable from a verified LIVE feed. Sample / screenshot data never produces CALL/PUT.
  if (base.decision !== "NO_TRADE" && (!input.source.verified || input.analysisKind !== "LIVE_FEED")) {
    base.decision = "NO_TRADE";
  }
  if (input.analysisKind === "SAMPLE") {
    warnings.unshift("SAMPLE DATA — synthetic candles for testing the engine. Not a market price. Not a signal.");
  }
  base.warnings = Array.from(new Set(warnings));
  return base;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  return n.toFixed(abs >= 100 ? 3 : abs >= 1 ? 5 : 6);
}

function round(n: number, d: number) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}
