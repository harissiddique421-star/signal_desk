import { describe, expect, it } from "vitest";
import { evaluateSignal, type EngineInput, type SourceInfo } from "@/lib/engine/signal";
import { DEFAULT_RULES } from "@/lib/config/rules";
import { afterClose, M, mirror, upWave } from "../helpers/series";

const LIVE_SRC: SourceInfo = { id: "test", name: "Test feed", verified: true, supportedMarketTypes: ["LIVE"] };
const SAMPLE_SRC: SourceInfo = { id: "sample", name: "Sample data (synthetic)", verified: false, supportedMarketTypes: ["LIVE", "OTC"] };

const bull = upWave().slice(0, 155); // known to satisfy every CALL rule
const bear = mirror(bull);

function run(over: Partial<EngineInput> = {}) {
  const candles = over.candles ?? bull;
  return evaluateSignal({
    candles,
    symbol: "EUR/USD",
    marketType: "LIVE",
    symbolSupported: true,
    source: LIVE_SRC,
    analysisKind: "LIVE_FEED",
    now: afterClose(candles),
    ...over,
  });
}

const failed = (r: ReturnType<typeof run>) => r.checks.filter((c) => !c.passed).map((c) => c.id);

describe("happy paths", () => {
  it("emits CALL when every gate passes on a verified live feed", () => {
    const r = run();
    expect(failed(r)).toEqual([]);
    expect(r.decision).toBe("CALL");
    expect(r.engineDecision).toBe("CALL");
    expect(r.agreementScore).toBeGreaterThanOrEqual(DEFAULT_RULES.minAgreement);
    expect(r.entryReference).toBe(bull[bull.length - 1].close);
    expect(r.signalCandleTime).toBe(bull[bull.length - 1].time);
    expect(r.entryWindowStart).toBe(bull[bull.length - 1].time + M);
    expect(r.entryWindowEnd).toBe(r.entryWindowStart! + DEFAULT_RULES.entryWindowSeconds * 1000);
    expect(r.expirySeconds).toBe(60);
    expect(r.evidence.length).toBeGreaterThan(4);
    expect(r.reasons).toEqual([]);
  });
  it("emits PUT on the mirrored series", () => {
    const r = run({ candles: bear });
    expect(failed(r)).toEqual([]);
    expect(r.decision).toBe("PUT");
  });
});

describe("source and market gates", () => {
  it("never emits a tradable signal from sample data, but reports what the rules saw", () => {
    const r = run({ source: SAMPLE_SRC, analysisKind: "SAMPLE" });
    expect(r.decision).toBe("NO_TRADE");
    expect(r.engineDecision).toBe("CALL");
    expect(r.reasons.join(" ")).toMatch(/not a verified live market feed/);
    expect(r.warnings[0]).toMatch(/SAMPLE DATA/);
  });
  it("refuses OTC when the source only covers regular markets", () => {
    const r = run({ marketType: "OTC" });
    expect(r.decision).toBe("NO_TRADE");
    expect(r.reasons.join(" ")).toMatch(/No verified data source for broker OTC prices/);
    expect(r.evidence).toEqual([]);
  });
  it("refuses unsupported symbols", () => {
    const r = run({ symbolSupported: false });
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toContain("source.symbol");
  });
  it("screenshot-derived analysis is never tradable", () => {
    const r = run({ analysisKind: "SCREENSHOT" });
    expect(r.decision).toBe("NO_TRADE");
  });
});

describe("data gates", () => {
  it("stale data → NO_TRADE with the exact age", () => {
    const r = run({ now: afterClose(bull, 3 * M) });
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toContain("data.freshness");
    expect(r.reasons.join(" ")).toMatch(/closed 180s ago/);
  });
  it("missing candle → NO_TRADE", () => {
    const gapped = [...bull.slice(0, 150), ...bull.slice(151)];
    const r = run({ candles: gapped, now: afterClose(bull) });
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toContain("data.gaps");
  });
  it("invalid OHLC → NO_TRADE", () => {
    const bad = bull.map((c, i) => (i === 140 ? { ...c, high: c.low - 0.001 } : c));
    const r = run({ candles: bad });
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toContain("data.ohlc");
  });
  it("too little history → NO_TRADE", () => {
    const short = bull.slice(-50);
    const r = run({ candles: short });
    expect(failed(r)).toEqual(["data.count"]);
  });
  it("ignores the still-forming candle (no look-ahead)", () => {
    const now = afterClose(bull);
    const forming = { time: bull[bull.length - 1].time + M, open: 1, high: 5, low: 0.5, close: 4 }; // absurd forming bar
    const r = run({ candles: [...bull, forming], now });
    expect(r.decision).toBe("CALL");
    expect(r.warnings.join(" ")).toMatch(/unfinished candle/);
  });
  it("future candles do not change the decision", () => {
    const now = afterClose(bull);
    const withFuture = upWave().slice(0, 170);
    expect(run({ candles: withFuture, now }).decision).toBe(run({ now }).decision);
  });
  it("entry window passed → NO_TRADE", () => {
    const r = run({ now: afterClose(bull, 30_000) });
    expect(r.decision).toBe("NO_TRADE");
    expect(failed(r)).toEqual(["timing.window"]);
  });
});

describe("filters", () => {
  it("news filter required but unavailable → NO_TRADE", () => {
    const r = run({ config: { ...DEFAULT_RULES, requireNewsFilter: true } });
    expect(failed(r)).toContain("news.available");
  });
  it("news filter unavailable and not required → warning only", () => {
    const r = run();
    expect(r.warnings.join(" ")).toMatch(/economic-calendar/);
  });
  it("high-impact news → NO_TRADE", () => {
    const r = run({ news: { available: true, blockingEvents: ["US CPI"] } });
    expect(failed(r)).toContain("news.clear");
  });
  it("shock candle → NO_TRADE", () => {
    const last = bull[bull.length - 1];
    const shocked = [...bull.slice(0, -1), { ...last, high: last.high + 0.01 }];
    const r = run({ candles: shocked });
    expect(failed(r)).toContain("vol.shock");
  });
  it("is deterministic", () => {
    expect(run()).toEqual(run());
  });
});
