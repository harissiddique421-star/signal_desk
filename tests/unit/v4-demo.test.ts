import { describe, expect, it } from "vitest";
import { dailyStopActive, effectiveOutcome, localDayKey, todaysTally, v4DemoProgress, type TrackedSignal } from "@/lib/client/signals-store";
import { DEFAULT_RULES, RuleConfigSchema } from "@/lib/config/rules";
import { MODE_OVERRIDES } from "@/lib/config/presets";
import { SignalModeSchema } from "@/lib/api/schemas";

const NOW = Date.parse("2026-10-14T10:00:00Z");
let k = 0;
function sig(over: Partial<TrackedSignal> = {}): TrackedSignal {
  k++;
  return { id: `p-${k}`, pair: "EUR/USD", provider: "twelvedata", marketType: "LIVE", decision: "CALL", signalCandleTime: NOW - k * 60_000, entryRef: 1, mode: "V4", kind: "AUTO", createdAt: NOW - k * 60_000, status: "RESOLVED", ...over };
}

describe("v4 demo preset", () => {
  it("is a valid rule config with the searched parameters", () => {
    const cfg = RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.V4 });
    expect(cfg.strategy).toBe("FADE_V2");
    expect(cfg.fadePercentBOutside).toBe(0.2);
    expect(cfg.fadeMinRangeAtr).toBe(3);
    expect(cfg.fadeRsiExtreme).toBe(75);
    expect(cfg.fadeRangeVsAtrIncludingSignal).toBe(true);
    expect(cfg.version).toBe("rules-v4-fade-demo");
    expect(SignalModeSchema.parse("V4")).toBe("V4");
  });
});

describe("Quotex outcome overrides the feed estimate", () => {
  it("uses the user's Quotex result when present", () => {
    expect(effectiveOutcome(sig({ outcome: "LOSS", quotexOutcome: "WIN" }))).toBe("WIN");
    expect(effectiveOutcome(sig({ outcome: "LOSS" }))).toBe("LOSS");
    const t = todaysTally([sig({ outcome: "LOSS", quotexOutcome: "WIN" }), sig({ outcome: "WIN" })], NOW, "V4");
    expect(t).toEqual({ wins: 2, losses: 0, ties: 0 });
  });
});

describe("daily loss stop", () => {
  const settings = { mode: "V4" as const, dailyLossLimit: 3, ignoreDailyStopOn: null };
  const losses = [sig({ outcome: "LOSS" }), sig({ outcome: "LOSS" }), sig({ quotexOutcome: "LOSS" })];
  it("stops after the limit is reached in the active mode", () => {
    expect(dailyStopActive(losses.slice(0, 2), NOW, settings)).toBe(false);
    expect(dailyStopActive(losses, NOW, settings)).toBe(true);
  });
  it("ignores other modes, can be switched off, and can be overridden for today only", () => {
    expect(dailyStopActive(losses, NOW, { ...settings, mode: "V2" })).toBe(false);
    expect(dailyStopActive(losses, NOW, { ...settings, dailyLossLimit: 0 })).toBe(false);
    expect(dailyStopActive(losses, NOW, { ...settings, ignoreDailyStopOn: localDayKey(NOW) })).toBe(false);
    expect(dailyStopActive(losses, NOW, { ...settings, ignoreDailyStopOn: "2000-01-01" })).toBe(true);
  });
});

describe("v4 demo progress", () => {
  it("counts only Quotex-marked v4 trades and gives no verdict before 300", () => {
    const list = [sig({ outcome: "WIN" }), sig({ quotexOutcome: "WIN" }), sig({ quotexOutcome: "LOSS" }), sig({ mode: "V2", quotexOutcome: "WIN" })];
    const p = v4DemoProgress(list, 0.9);
    expect(p).toMatchObject({ signals: 3, marked: 2, wins: 1, losses: 1, n: 2, verdict: "NOT_ENOUGH" });
    expect(p.breakEven).toBeCloseTo(1 / 1.9);
  });
  it("judges after 300 trades against break-even", () => {
    const mk = (w: number, l: number) => [...Array(w)].map(() => sig({ quotexOutcome: "WIN" })).concat([...Array(l)].map(() => sig({ quotexOutcome: "LOSS" })));
    expect(v4DemoProgress(mk(200, 100), 0.9).verdict).toBe("EDGE");
    expect(v4DemoProgress(mk(120, 180), 0.9).verdict).toBe("LOSING");
    expect(v4DemoProgress(mk(160, 140), 0.9).verdict).toBe("UNPROVEN");
  });
});
