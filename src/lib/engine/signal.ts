import type { RuleConfig } from "../config/rules";
import { DEFAULT_RULES } from "../config/rules";
import { atr, bollinger, ema, macd, percentileRank, qqe, rsi } from "../indicators";
import type { AnalysisKind, Candle, Check, Decision, Direction, Evidence, MarketType, SignalMetrics, SignalResult } from "../types";
import { checkFreshness, closedCandlesOnly, inspectSeries } from "../validation/candles";
import { anatomy, detectPatterns } from "../analysis/candles";
import { buildZones, detectBreakouts, findSwings, marketStructure, nearestZones, resample } from "../analysis/structure";
import { isFxWeekendClosed } from "../analysis/market-hours";

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
  const fastMode = cfg.version === "rules-fast-confluence-experimental";
  const qqeMode = cfg.strategy === "QQE_SR";
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
    metrics: null,
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
    report.missing.length <= cfg.maxMissingCandles,
    report.missing.length
      ? `${report.missing.length} missing in last ${cfg.gapLookback} (allowed ${cfg.maxMissingCandles}; first ${new Date(report.missing[0]).toISOString()})`
      : `None in last ${cfg.gapLookback}`,
  );
  const fresh = checkFreshness(closed, tfMs, input.now, cfg.maxStalenessSeconds);
  // FAST only: the free Twelve Data feed often publishes the just-closed candle 10–20 s
  // late, so every scan inside the entry window failed freshness and FAST never fired.
  // If the feed is exactly ONE candle behind, FAST uses the previous closed candle and
  // anchors the trade to the current minute. A feed further behind still fails closed.
  const fastLagged =
    (fastMode || qqeMode) &&
    !fresh.fresh &&
    closed.length > 0 &&
    closed[closed.length - 1].time === fresh.expectedLastOpen - tfMs &&
    closed[closed.length - 1].time <= input.now;
  addCheck(
    "data.freshness",
    "Freshness",
    fresh.fresh || fastLagged,
    fastLagged ? `Feed is one candle behind; FAST uses the previous closed candle (${fresh.detail})` : fresh.detail,
  );
  if (fastLagged) warnings.push("FAST: latest candle not published yet by the feed — direction taken from the previous closed candle.");
  if (input.marketType === "LIVE" && input.analysisKind === "LIVE_FEED") {
    // Feeds that keep printing candles over the weekend must not produce signals:
    // the regular FX market is closed and the rules were never tested on those minutes.
    const last = closed[closed.length - 1];
    const weekend = isFxWeekendClosed(last.time) || isFxWeekendClosed(input.now);
    addCheck("data.marketHours", "Market hours", !weekend, weekend ? "Regular FX market is closed (Friday 21:00 – Sunday 22:00 UTC)" : "Regular FX market open");
  }
  if (reasons.length && checks.some((c) => c.id.startsWith("data.") && !c.passed)) {
    warnings.push(UR.noData);
    return finalize(base, input, warnings);
  }

  const lastC = closed[closed.length - 1];
  // When FAST runs one candle behind, the trade is still the CURRENT minute's candle,
  // so the signal is anchored to the candle that just closed (even though the feed has
  // not delivered it yet). Results are then resolved on the right trade candle.
  const anchorTime = fastLagged ? fresh.expectedLastOpen : lastC.time;
  base.signalCandleTime = anchorTime;
  base.entryReference = lastC.close;
  base.entryWindowStart = anchorTime + tfMs;
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
  const fadeMode = cfg.strategy === "FADE_V2";
  const atrSample = (a.slice(-cfg.volatilityWindow).filter((x) => x !== null) as number[]);
  const atrPct = percentileRank(atrSample, atrNow);
  const lastRange = lastC.high - lastC.low;
  if (!fadeMode && !fastMode && !qqeMode) {
    // TREND_V1 avoids quiet markets and shock candles. FADE_V2 trades exactly the
    // large candles these filters remove, so it uses its own setup checks instead.
    addCheck(
      "vol.atrRange",
      "Volatility",
      atrPct >= cfg.minAtrPercentile && atrPct <= cfg.maxAtrPercentile,
      `ATR percentile ${atrPct.toFixed(0)} (allowed ${cfg.minAtrPercentile}–${cfg.maxAtrPercentile})${atrPct < cfg.minAtrPercentile ? " — market too quiet" : atrPct > cfg.maxAtrPercentile ? " — volatility spike" : ""}`,
    );
    addCheck(
      "vol.shock",
      "Shock candle",
      lastRange <= cfg.shockCandleAtr * atrPrev,
      `Last range ${(lastRange / atrPrev).toFixed(2)}× ATR (limit ${cfg.shockCandleAtr}×)`,
    );
  }

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
  if (qqeMode) {
    return decideQqe({ cfg, base, input, warnings, checks, evidence, addCheck, lastC, an, rv, pb, h, atrPct, lastRange, atrPrev, atrNow, emaDir, msDir, mtfDir, ms, swings, windowOpen, closed, closes });
  }
  if (fadeMode) {
    return decideFade({ cfg, base, input, warnings, checks, evidence, addCheck, lastC, an, rv, pb, h, atrPct, lastRange, atrPrev, atrNow, emaDir, msDir, mtfDir, ms, swings, windowOpen });
  }
  const weightedWant: Direction = agreement > 0 ? "BULLISH" : agreement < 0 ? "BEARISH" : "NEUTRAL";
  // In FAST mode, always produce a directional candidate from valid, fresh candles.
  // If indicator weights tie, use the last CLOSED candle direction; a doji falls back
  // to the latest non-doji candle. This is a forced demo candidate, not a validated edge.
  const lastDirectionalCandle = [...closed].reverse().find((c) => c.close !== c.open);
  const fastFallback: Direction = lastDirectionalCandle
    ? (lastDirectionalCandle.close > lastDirectionalCandle.open ? "BULLISH" : "BEARISH")
    : "NEUTRAL";
  const want: Direction = fastMode && weightedWant === "NEUTRAL" ? fastFallback : weightedWant;
  const supporting = want === "NEUTRAL" ? 0 : evidence.filter((e) => e.direction === want).length;

  // FAST is an explicitly permissive, user-directed experimental vote mode.
  // Keep source, symbol, candle integrity/freshness, market-hours and entry-window
  // gates above/below, but do not silently apply the stricter trend/structure/RSI/level filters.
  if (fastMode) {
    addCheck("decision.fastDirection", "Forced FAST direction", want !== "NEUTRAL", want === "NEUTRAL" ? "No directional candle available" : weightedWant === "NEUTRAL" ? `${want} selected from latest non-doji closed candle because evidence was tied` : `${want} has the stronger weighted evidence`);
    addCheck("decision.fastVotes", "Matching strategy votes", true, `${supporting} evidence items match ${want}; FAST force-signal mode does not require a vote minimum`);
    warnings.push("FORCED FAST DEMO CANDIDATE: a CALL/PUT is shown from the available candle direction even without confluence. This is not a validated trading signal; verify manually and test in demo only.");
    const metrics: SignalMetrics = {
      atrPercentile: round(atrPct, 1),
      lastRangeAtr: round(lastRange / atrPrev, 3),
      bodyRatio: round(an.bodyRatio, 3),
      lastCandleDir: lastC.close > lastC.open ? 1 : lastC.close < lastC.open ? -1 : 0,
      rsi: round(rv, 2),
      macdHistogram: h,
      bbPercentB: round(pb, 3),
      emaTrend: emaDir,
      structure: ms.state,
      mtfTrend: mtfDir,
      opposingLevelAtr: null,
      regime: atrPct > cfg.maxAtrPercentile ? "HIGH_VOL" : emaDir !== "NEUTRAL" && emaDir === msDir ? "TREND" : ms.state === "RANGE" ? "RANGE" : "UNCERTAIN",
    };
    base.metrics = metrics;
    addCheck("timing.window", "Entry window", windowOpen, windowOpen ? `Act before ${new Date(base.entryWindowEnd).toISOString()}` : "Entry window already passed — signal expired");
    const passedFast = reasons.length === 0;
    base.engineDecision = sourceIndependentDecision(checks, want);
    if (passedFast) base.decision = want === "BULLISH" ? "CALL" : want === "BEARISH" ? "PUT" : "NO_TRADE";
    warnings.push("FAST mode is permissive and experimental; 2 matching evidence items are not 2 independently validated strategies.");
    return finalize(base, input, warnings);
  }

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

  const opposing = want === "BULLISH" ? (resistance ? (resistance.low - close) / atrNow : null) : want === "BEARISH" ? (support ? (close - support.high) / atrNow : null) : null;
  const metrics: SignalMetrics = {
    atrPercentile: round(atrPct, 1),
    lastRangeAtr: round(lastRange / atrPrev, 3),
    bodyRatio: round(an.bodyRatio, 3),
    lastCandleDir: lastC.close > lastC.open ? 1 : lastC.close < lastC.open ? -1 : 0,
    rsi: round(rv, 2),
    macdHistogram: h,
    bbPercentB: round(pb, 3),
    emaTrend: emaDir,
    structure: ms.state,
    mtfTrend: mtfDir,
    opposingLevelAtr: opposing === null ? null : round(opposing, 3),
    regime: atrPct > cfg.maxAtrPercentile ? "HIGH_VOL" : emaDir !== "NEUTRAL" && emaDir === msDir ? "TREND" : ms.state === "RANGE" ? "RANGE" : "UNCERTAIN",
  };
  base.metrics = metrics;

  addCheck("timing.window", "Entry window", windowOpen, windowOpen ? `Act before ${new Date(base.entryWindowEnd).toISOString()}` : "Entry window already passed — signal expired");

  const passed = reasons.length === 0;
  base.engineDecision = sourceIndependentDecision(checks, want);
  if (passed) base.decision = want === "BULLISH" ? "CALL" : "PUT";
  return finalize(base, input, warnings);
}

interface FadeContext {
  cfg: RuleConfig;
  base: SignalResult;
  input: EngineInput;
  warnings: string[];
  checks: Check[];
  evidence: Evidence[];
  addCheck: (id: string, label: string, passed: boolean, detail: string) => boolean;
  lastC: Candle;
  an: ReturnType<typeof anatomy>;
  rv: number;
  pb: number;
  h: number;
  atrPct: number;
  lastRange: number;
  atrPrev: number;
  atrNow: number;
  emaDir: Direction;
  msDir: Direction;
  mtfDir: Direction;
  ms: ReturnType<typeof marketStructure>;
  swings: ReturnType<typeof findSwings>;
  windowOpen: boolean;
}

/**
 * FADE_V2: trade AGAINST a stretched 1-minute candle.
 * Setup (all on the closed signal candle):
 *   - it closed outside the Bollinger band in its own direction (%B > 1 up / < 0 down),
 *   - its range is at least `fadeMinRangeAtr` ATRs and its body at least `fadeMinBodyRatio` of the range,
 *   - RSI is at an extreme in the same direction,
 *   - the hour (UTC) is not blocked.
 * Then PUT after an up-candle, CALL after a down-candle.
 */
function decideFade(x: FadeContext): SignalResult {
  const { cfg, base, input, warnings, checks, evidence, addCheck, lastC, an, rv, pb } = x;
  const up = lastC.close > lastC.open;
  const down = lastC.close < lastC.open;
  const stretchedUp = up && pb > 1 + cfg.fadePercentBOutside;
  const stretchedDown = down && pb < -cfg.fadePercentBOutside;
  const want: Direction = stretchedUp ? "BEARISH" : stretchedDown ? "BULLISH" : "NEUTRAL";
  const rangeAtr = x.lastRange / (cfg.fadeRangeVsAtrIncludingSignal ? x.atrNow : x.atrPrev);

  addCheck(
    "fade.stretch",
    "Stretched candle",
    want !== "NEUTRAL",
    want === "NEUTRAL" ? `Close inside the Bollinger band or candle against the stretch (%B ${pb.toFixed(2)})` : `${up ? "Up" : "Down"} candle closed ${up ? "above the upper" : "below the lower"} band (%B ${pb.toFixed(2)})`,
  );
  addCheck("fade.range", "Large candle", rangeAtr >= cfg.fadeMinRangeAtr, `range ${rangeAtr.toFixed(2)}× ATR (need ${cfg.fadeMinRangeAtr}×)`);
  addCheck("fade.body", "Decisive body", an.bodyRatio >= cfg.fadeMinBodyRatio, `body ${(an.bodyRatio * 100).toFixed(0)}% of range (need ${(cfg.fadeMinBodyRatio * 100).toFixed(0)}%)`);
  const rsiOk = up ? rv >= cfg.fadeRsiExtreme : down ? rv <= 100 - cfg.fadeRsiExtreme : false;
  addCheck("fade.rsi", "RSI extreme", rsiOk, `RSI ${rv.toFixed(1)} (need ${up ? `≥ ${cfg.fadeRsiExtreme}` : `≤ ${100 - cfg.fadeRsiExtreme}`})`);
  const hour = new Date(lastC.time).getUTCHours(); // hour of the signal candle, as in the research split
  addCheck("session.hours", "Trading hours", !cfg.blockedHoursUtc.includes(hour), cfg.blockedHoursUtc.includes(hour) ? `${hour}:00 UTC is blocked (rollover hours: thin quotes, wide spreads)` : `${hour}:00 UTC allowed`);

  if (want !== "NEUTRAL") {
    evidence.push({
      id: "setup.fade",
      module: "Exhaustion fade",
      label: want === "BEARISH" ? "Stretched up-candle → fade down" : "Stretched down-candle → fade up",
      direction: want,
      weight: 3,
      detail: `%B ${pb.toFixed(2)}, range ${rangeAtr.toFixed(2)}× ATR, body ${(an.bodyRatio * 100).toFixed(0)}%, RSI ${rv.toFixed(1)}`,
      detailUr:
        want === "BEARISH"
          ? "Bari hari candle Bollinger band se bahar band hui aur RSI hadd par hai — aksar agli candle mein thora wapas aata hai."
          : "Bari laal candle Bollinger band se neeche band hui aur RSI hadd par hai — aksar agli candle mein thora wapas aata hai.",
    });
  }
  warnings.push("FADE_V2 edge is small and decays within seconds: enter at the very start of the next candle or skip.");
  if (x.mtfDir !== "NEUTRAL" && want !== "NEUTRAL" && x.mtfDir !== want) warnings.push(`Fading against the ${cfg.mtfMinutes}m trend (${x.mtfDir.toLowerCase()})`);

  const metrics: SignalMetrics = {
    atrPercentile: round(x.atrPct, 1),
    lastRangeAtr: round(rangeAtr, 3),
    bodyRatio: round(an.bodyRatio, 3),
    lastCandleDir: up ? 1 : down ? -1 : 0,
    rsi: round(rv, 2),
    macdHistogram: x.h,
    bbPercentB: round(pb, 3),
    emaTrend: x.emaDir,
    structure: x.ms.state,
    mtfTrend: x.mtfDir,
    opposingLevelAtr: null,
    regime: x.atrPct > cfg.maxAtrPercentile ? "HIGH_VOL" : x.emaDir !== "NEUTRAL" && x.emaDir === x.msDir ? "TREND" : x.ms.state === "RANGE" ? "RANGE" : "UNCERTAIN",
  };
  base.metrics = metrics;

  addCheck("timing.window", "Entry window", x.windowOpen, x.windowOpen ? `Act before ${new Date(base.entryWindowEnd!).toISOString()}` : "Entry window already passed — signal expired");

  const passed = checks.every((c) => c.passed);
  base.engineDecision = sourceIndependentDecision(checks, want);
  if (passed) base.decision = want === "BULLISH" ? "CALL" : "PUT";
  return finalize(base, input, warnings);
}

interface QqeContext extends FadeContext {
  closed: Candle[];
  closes: number[];
}

/**
 * QQE_SR — three entries on the CLOSED signal candle (non-repainting), any one is enough:
 *   1. QQE flip: smoothed RSI crosses its QQE trailing line (momentum turns).
 *   2. S/R rejection: the candle's wick pokes into a support (resistance) zone and is
 *      rejected — long wick, close back on the right side of the zone.
 *   3. Momentum run: `momentumCandles` same-colour candles with solid bodies, in the
 *      same direction as the QQE phase.
 * Entries pointing opposite ways cancel out (NO_TRADE). Built from public indicator
 * definitions; not validated — demo only.
 */
function decideQqe(x: QqeContext): SignalResult {
  const { cfg, base, input, warnings, checks, evidence, addCheck, lastC, an, rv, closed, closes } = x;
  const i = closes.length - 1;
  const q = qqe(closes, cfg.qqeRsiPeriod, cfg.qqeSmoothing, cfg.qqeFactor);
  const m = q.rsiMa[i];
  const mp = q.rsiMa[i - 1];
  const tr = q.trail[i];
  const trp = q.trail[i - 1];
  const phase = q.trend[i];
  if (m === null || mp === null || tr === null || trp === null || phase === null) {
    addCheck("data.warmup", "Indicator warm-up", false, "Not enough history for QQE");
    return finalize(base, input, warnings);
  }

  const votes: { dir: Direction; id: string; label: string; detail: string; detailUr: string }[] = [];

  // 1. QQE flip
  if (mp <= trp && m > tr) votes.push({ dir: "BULLISH", id: "qqe.flip", label: "QQE flip up", detail: `RSI-MA ${m.toFixed(1)} crossed above QQE line ${tr.toFixed(1)}`, detailUr: "QQE line upar ki taraf palti — momentum upar mur gaya." });
  if (mp >= trp && m < tr) votes.push({ dir: "BEARISH", id: "qqe.flip", label: "QQE flip down", detail: `RSI-MA ${m.toFixed(1)} crossed below QQE line ${tr.toFixed(1)}`, detailUr: "QQE line neeche ki taraf palti — momentum neeche mur gaya." });

  // 2. Support / resistance rejection
  const zones = buildZones(x.swings, lastC.close, cfg.levelMergeAtr * x.atrNow);
  const { support, resistance } = nearestZones(zones, lastC.close);
  const prox = cfg.levelProximityAtr * x.atrNow;
  if (support && lastC.low <= support.high + prox && lastC.close > support.high && an.lowerWickRatio >= cfg.rejectionWickRatio) {
    votes.push({ dir: "BULLISH", id: "sr.reject", label: "Support rejection", detail: `Wick into support ${fmt(support.low)}–${fmt(support.high)} (${support.touches} touches), lower wick ${(an.lowerWickRatio * 100).toFixed(0)}%`, detailUr: "Price support tak gayi aur lambi wick ke saath wapas upar band hui." });
  }
  if (resistance && lastC.high >= resistance.low - prox && lastC.close < resistance.low && an.upperWickRatio >= cfg.rejectionWickRatio) {
    votes.push({ dir: "BEARISH", id: "sr.reject", label: "Resistance rejection", detail: `Wick into resistance ${fmt(resistance.low)}–${fmt(resistance.high)} (${resistance.touches} touches), upper wick ${(an.upperWickRatio * 100).toFixed(0)}%`, detailUr: "Price resistance tak gayi aur lambi wick ke saath wapas neeche band hui." });
  }

  // 3. Momentum run in the QQE phase
  const run = closed.slice(-cfg.momentumCandles);
  const solid = (c: Candle) => {
    const r = c.high - c.low;
    return r > 0 && Math.abs(c.close - c.open) / r >= 0.5;
  };
  if (run.length === cfg.momentumCandles && run.every((c) => c.close > c.open && solid(c)) && phase === 1 && m > 50) {
    votes.push({ dir: "BULLISH", id: "momentum.run", label: `${cfg.momentumCandles} green candles + QQE up`, detail: `${cfg.momentumCandles} solid up candles, RSI-MA ${m.toFixed(1)}`, detailUr: `Lagatar ${cfg.momentumCandles} mazboot hari candles aur QQE upar — rujhan jaari.` });
  }
  if (run.length === cfg.momentumCandles && run.every((c) => c.close < c.open && solid(c)) && phase === -1 && m < 50) {
    votes.push({ dir: "BEARISH", id: "momentum.run", label: `${cfg.momentumCandles} red candles + QQE down`, detail: `${cfg.momentumCandles} solid down candles, RSI-MA ${m.toFixed(1)}`, detailUr: `Lagatar ${cfg.momentumCandles} mazboot laal candles aur QQE neeche — rujhan jaari.` });
  }

  const dirs = new Set(votes.map((v) => v.dir));
  const want: Direction = dirs.size === 1 ? votes[0].dir : "NEUTRAL";
  addCheck(
    "qqe.entry",
    "QQE / S/R entry",
    votes.length > 0,
    votes.length ? votes.map((v) => v.label).join(", ") : `No entry: QQE ${phase === 1 ? "up" : "down"}-phase without a flip, no level rejection, no ${cfg.momentumCandles}-candle run`,
  );
  if (votes.length) addCheck("qqe.agree", "Entries agree", dirs.size === 1, dirs.size === 1 ? `${votes.length} entr${votes.length > 1 ? "ies" : "y"} ${want.toLowerCase()}` : "Entries point opposite ways");
  for (const v of votes) evidence.push({ id: `setup.${v.id}`, module: "QQE + S/R", label: v.label, direction: v.dir, weight: 3, detail: v.detail, detailUr: v.detailUr });
  if (want === "BULLISH" && rv >= cfg.rsiOverbought) warnings.push(`RSI ${rv.toFixed(0)} already overbought`);
  if (want === "BEARISH" && rv <= cfg.rsiOversold) warnings.push(`RSI ${rv.toFixed(0)} already oversold`);
  warnings.push("QQE + S/R is experimental (public QQE/pivot rules, not validated) — demo only.");

  base.metrics = {
    atrPercentile: round(x.atrPct, 1),
    lastRangeAtr: round(x.lastRange / x.atrPrev, 3),
    bodyRatio: round(an.bodyRatio, 3),
    lastCandleDir: lastC.close > lastC.open ? 1 : lastC.close < lastC.open ? -1 : 0,
    rsi: round(rv, 2),
    macdHistogram: x.h,
    bbPercentB: round(x.pb, 3),
    emaTrend: x.emaDir,
    structure: x.ms.state,
    mtfTrend: x.mtfDir,
    opposingLevelAtr: null,
    regime: x.atrPct > cfg.maxAtrPercentile ? "HIGH_VOL" : x.emaDir !== "NEUTRAL" && x.emaDir === x.msDir ? "TREND" : x.ms.state === "RANGE" ? "RANGE" : "UNCERTAIN",
  };
  addCheck("timing.window", "Entry window", x.windowOpen, x.windowOpen ? `Act before ${new Date(base.entryWindowEnd!).toISOString()}` : "Entry window already passed — signal expired");

  const passed = checks.every((c) => c.passed);
  base.engineDecision = sourceIndependentDecision(checks, want);
  if (passed && want !== "NEUTRAL") base.decision = want === "BULLISH" ? "CALL" : "PUT";
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
