import { describe, expect, it } from "vitest";
import fixture from "../fixtures/ml-v3.json";
import { computeFeatures, FEATURE_NAMES } from "@/lib/ml/features";
import { decideFromProbability, isotonic, pairCode, predictRaw, shadowPredict } from "@/lib/ml/model";
import type { Candle } from "@/lib/types";
import { shadowDecisions } from "@/lib/engine/shadow";
import { evaluateSignal } from "@/lib/engine/signal";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";
import { MODE_OVERRIDES } from "@/lib/config/presets";
import { versionComparison } from "@/lib/client/signals-store";

const series = fixture.series as Record<string, Candle[]>;

describe("v3 shadow model — parity with the Python research pipeline", () => {
  for (const c of fixture.checks) {
    const pair = c.pair.replace("/", "_");
    const window = series[pair].slice(c.windowEnd - 299, c.windowEnd + 1);

    it(`${c.pair} bar ${c.windowEnd}: features match features.py`, () => {
      const f = computeFeatures(window)!;
      expect(f).not.toBeNull();
      for (const k of FEATURE_NAMES) {
        const want = (c.features as Record<string, number>)[k];
        // pandas' rolling std uses an online algorithm; Bollinger-based features differ by float noise (~1e-9).
        const tol = k === "pb" || k === "bbwAtr" ? 1e-7 : 1e-9;
        expect(Math.abs(f[k] - want), k).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(want)));
      }
    });

    it(`${c.pair} bar ${c.windowEnd}: probability matches LightGBM`, () => {
      const raw = predictRaw(computeFeatures(window)!, pairCode(c.pair)!);
      expect(raw).toBeCloseTo(c.rawProbability, 9);
      expect(isotonic(raw)).toBeCloseTo(c.probability, 9);
    });
  }
});

describe("v3 shadow model — decisions", () => {
  it("abstains inside the frozen margin and picks a side outside it", () => {
    expect(decideFromProbability(0.5)).toBe("NO_TRADE");
    expect(decideFromProbability(0.579)).toBe("NO_TRADE");
    expect(decideFromProbability(0.58)).toBe("CALL");
    expect(decideFromProbability(0.42)).toBe("PUT");
  });

  it("does not predict for pairs it was never trained on", () => {
    expect(pairCode("USD/JPY")).toBeNull();
    expect(shadowPredict(series.EUR_USD.slice(-300), "USD/JPY")).toBeNull();
  });

  it("needs enough history", () => {
    expect(computeFeatures(series.EUR_USD.slice(-50))).toBeNull();
  });

  it("uses only the candles it is given (adding a later candle changes nothing for the earlier bar)", () => {
    const w = series.EUR_USD.slice(100, 400);
    const a = shadowPredict(w, "EUR/USD")!;
    const b = shadowPredict(series.EUR_USD.slice(100, 400), "EUR/USD")!;
    expect(a.probability).toBe(b.probability);
    const later = shadowPredict(series.EUR_USD.slice(101, 401), "EUR/USD")!;
    expect(later.features).not.toEqual(a.features);
  });
});

describe("shadow mode", () => {
  const LIVE = { id: "t", name: "Test", verified: true, supportedMarketTypes: ["LIVE" as const] };
  const candles = series.EUR_USD.slice(-300);
  const base = { candles, symbol: "EUR/USD", marketType: "LIVE" as const, symbolSupported: true, source: LIVE, analysisKind: "LIVE_FEED" as const, now: candles[candles.length - 1].time + 60_000 + 1000 };
  const strict = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.STRICT });

  it("runs v2 and v3 on the same minute and marks it as an opportunity", () => {
    const active = evaluateSignal({ ...base, config: strict });
    const sh = shadowDecisions(base, "STRICT", active);
    expect(sh.map((s) => s.version)).toEqual(["rules-v2-fade", "v3-ml-shadow"]);
    expect(sh.every((s) => s.eligible)).toBe(true);
    expect(sh[1].probability).toBeGreaterThan(0);
  });

  it("fails closed on data problems: every version NO_TRADE, not an opportunity", () => {
    const gapped = candles.filter((_, i) => i !== candles.length - 10);
    const input = { ...base, candles: gapped };
    const sh = shadowDecisions(input, "V2", evaluateSignal({ ...input, config: RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.V2 }) }));
    expect(sh.every((s) => s.decision === "NO_TRADE" && !s.eligible)).toBe(true);
  });

  it("never runs on unverified data", () => {
    const input = { ...base, source: { ...LIVE, verified: false }, analysisKind: "SAMPLE" as const };
    const sh = shadowDecisions(input, "V2", evaluateSignal({ ...input, config: strict }));
    expect(sh.every((s) => s.decision === "NO_TRADE" && !s.eligible)).toBe(true);
  });

  it("does not run v3 on pairs it was not trained on", () => {
    const input = { ...base, symbol: "USD/JPY" };
    const sh = shadowDecisions(input, "V2", evaluateSignal({ ...input, config: strict }));
    expect(sh[1]).toMatchObject({ decision: "NO_TRADE", eligible: false });
  });

  it("compares versions on coverage and results, ignoring forced records", () => {
    const rec = (over: object) => ({ id: Math.random().toString(), pair: "EUR/USD", provider: "p", marketType: "LIVE" as const, decision: "CALL" as const, signalCandleTime: 0, entryRef: 1, mode: "V2" as const, createdAt: 0, status: "RESOLVED" as const, ...over });
    const rows = versionComparison(
      [rec({ kind: "AUTO", ruleVersion: "rules-v2-fade", outcome: "WIN" }), rec({ kind: "SHADOW", ruleVersion: "v3-ml-shadow", outcome: "LOSS" }), rec({ kind: "MANUAL", outcome: "WIN" })],
      { "rules-v2-fade": 100, "v3-ml-shadow": 100 },
    );
    expect(rows[0]).toMatchObject({ signals: 1, wins: 1, coverage: 0.01 });
    expect(rows[1]).toMatchObject({ signals: 1, losses: 1, coverage: 0.01 });
  });
});
