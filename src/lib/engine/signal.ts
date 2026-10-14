import type { RuleConfig } from "../config/rules";
import { DEFAULT_RULES } from "../config/rules";
import { atr, bollinger, ema, macd, percentileRank, rsi } from "../indicators";
import type { AnalysisKind, Candle, Check, Decision, Direction, Evidence, MarketType, SignalMetrics, SignalResult } from "../types";
import { checkFreshness, closedCandlesOnly, inspectSeries } from "../validation/candles";
import { anatomy, CONTINUATION_PATTERNS, detectPatterns, PATTERN_UR, REVERSAL_PATTERNS, type PatternHit } from "../analysis/candles";
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
  const fastMode = cfg.version.startsWith("rules-fast");
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
    fastMode &&
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
  if (!fadeMode && !fastMode) {
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
  const patterns = detectPatterns(closed.slice(-3), { extended: fastMode });
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
  if (fadeMode) {
    return decideFade({ cfg, base, input, warnings, checks, evidence, addCheck, lastC, an, rv, pb, h, atrPct, lastRange, atrPrev, atrNow, emaDir, msDir, mtfDir, ms, swings, windowOpen });
  }
  if (fastMode) {
    return decidePattern({ cfg, base, input, warnings, checks, evidence, addCheck, lastC, an, rv, pb, h, atrPct, lastRange, atrPrev, atrNow, emaDir, msDir, mtfDir, ms, swings, windowOpen, patterns, close, lowerBand: bb.lower[i], upperBand: bb.upper[i] });
  }
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

interface PatternContext extends FadeContext {
  patterns: PatternHit[];
  close: number;
  lowerBand: number | null;
  upperBand: number | null;
}

const pname = (p: PatternHit) => p.name.replaceAll("_", " ").toLowerCase();

/**
 * FAST = candlestick-pattern strategy. A CALL/PUT needs a directional pattern on the
 * signal candle AND the right place for it:
 *   - reversal patterns (engulfing, hammer, shooting star, morning/evening star,
 *     tweezers, piercing line, dark cloud) at support/resistance, at a Bollinger band,
 *     or with RSI stretched (≤ 35 / ≥ 65);
 *   - continuation patterns (marubozu, three soldiers/crows) with the EMA trend on
 *     their side, RSI not exhausted and no opposing level right in front of price.
 * Conflicting patterns, or a pattern in the wrong place, give NO_TRADE.
 */
function decidePattern(x: PatternContext): SignalResult {
  const { cfg, base, input, warnings, checks, evidence, addCheck, lastC, an, rv, close } = x;
  const directional = x.patterns.filter((p) => p.direction !== "NEUTRAL");
  const bullP = directional.filter((p) => p.direction === "BULLISH");
  const bearP = directional.filter((p) => p.direction === "BEARISH");
  const conflict = bullP.length > 0 && bearP.length > 0;
  const want: Direction = conflict ? "NEUTRAL" : bullP.length ? "BULLISH" : bearP.length ? "BEARISH" : "NEUTRAL";
  const pats = want === "BULLISH" ? bullP : want === "BEARISH" ? bearP : [];

  addCheck(
    "pattern.found",
    "Candle pattern",
    want !== "NEUTRAL",
    conflict ? `Conflicting patterns (${directional.map(pname).join(", ")})` : pats.length ? pats.map(pname).join(", ") : "No directional candlestick pattern on the signal candle",
  );

  const zones = buildZones(x.swings, close, cfg.levelMergeAtr * x.atrNow);
  const { support, resistance } = nearestZones(zones, close);
  const prox = cfg.levelProximityAtr * x.atrNow;
  const reversal = pats.find((p) => REVERSAL_PATTERNS.has(p.name));
  const cont = pats.find((p) => CONTINUATION_PATTERNS.has(p.name));
  let used: PatternHit | undefined;
  let setupDetail = "";
  let setupOk = false;
  if (want === "BULLISH" || want === "BEARISH") {
    const up = want === "BULLISH";
    const atLevel = up ? !!support && lastC.low - support.high <= prox : !!resistance && resistance.low - lastC.high <= prox;
    const atBand = up ? x.lowerBand !== null && lastC.low <= x.lowerBand : x.upperBand !== null && lastC.high >= x.upperBand;
    const rsiStretched = up ? rv <= 35 : rv >= 65;
    const roomAhead = up ? !(resistance && resistance.low - close <= prox) : !(support && close - support.high <= prox);
    const rsiOk = up ? rv < cfg.rsiOverbought : rv > cfg.rsiOversold;
    if (reversal && (atLevel || atBand || rsiStretched)) {
      setupOk = true;
      used = reversal;
      const where = [atLevel && (up ? "support" : "resistance"), atBand && (up ? "lower band" : "upper band"), rsiStretched && `RSI ${rv.toFixed(0)}`].filter(Boolean).join(" + ");
      setupDetail = `${pname(reversal)} at ${where}`;
    } else if (cont && x.emaDir === want && rsiOk && roomAhead) {
      setupOk = true;
      used = cont;
      setupDetail = `${pname(cont)} with the ${up ? "up" : "down"}-trend, room to the next level`;
    } else if (reversal) {
      setupDetail = `${pname(reversal)} is not at ${up ? "support, the lower band or low RSI" : "resistance, the upper band or high RSI"} — no reason to turn here`;
    } else if (cont) {
      setupDetail = x.emaDir !== want ? `${pname(cont)} against the EMA trend (${x.emaDir.toLowerCase()})` : !rsiOk ? `${pname(cont)} but RSI exhausted (${rv.toFixed(0)})` : `${pname(cont)} runs straight into ${up ? "resistance" : "support"}`;
    }
  }
  if (want !== "NEUTRAL") addCheck("pattern.setup", "Pattern in the right place", setupOk, setupDetail);

  if (used) {
    evidence.push({
      id: "setup.pattern",
      module: "Candle pattern strategy",
      label: used.name.replaceAll("_", " "),
      direction: want,
      weight: 3,
      detail: setupDetail,
      detailUr: PATTERN_UR[used.name],
    });
  }
  if (x.mtfDir !== "NEUTRAL" && want !== "NEUTRAL" && x.mtfDir !== want) warnings.push(`Pattern is against the ${cfg.mtfMinutes}m trend (${x.mtfDir.toLowerCase()})`);
  warnings.push("FAST pattern strategy is experimental and not yet proven — demo only. The signal candle may still be forming when the app checks.");

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
