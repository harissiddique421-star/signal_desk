import { describe, expect, it } from "vitest";
import { assessStrategyHealth } from "@/lib/stats/monitor";
import { autoOutcomes, migrateSettings, todaysTally, type TrackedSignal } from "@/lib/client/signals-store";
import type { Outcome } from "@/lib/stats/performance";

const seq = (wins: number, losses: number): Outcome[] => [...Array(wins).fill("WIN"), ...Array(losses).fill("LOSS")];

describe("assessStrategyHealth", () => {
  it("does not judge with too few results", () => {
    expect(assessStrategyHealth(seq(2, 10), 0.85).status).toBe("INSUFFICIENT");
  });
  it("is OK above break-even", () => {
    expect(assessStrategyHealth(seq(30, 20), 0.85).status).toBe("OK");
  });
  it("is only WATCH when below break-even but not conclusive", () => {
    // 25/50 = 50 %: below 54 % break-even, but the 95 % CI reaches above it.
    expect(assessStrategyHealth(seq(25, 25), 0.85).status).toBe("WATCH");
  });
  it("is DEGRADED when the whole 95 % interval is below break-even", () => {
    const h = assessStrategyHealth(seq(14, 36), 0.85);
    expect(h.status).toBe("DEGRADED");
    expect(h.ci95![1]).toBeLessThan(h.breakEven);
  });
  it("looks only at the most recent window and ignores ties", () => {
    const old = seq(0, 100);
    const recent: Outcome[] = [...seq(35, 15), "TIE", "TIE"];
    expect(assessStrategyHealth([...old, ...recent], 0.85, { window: 50 }).status).toBe("OK");
  });
});

const sig = (over: Partial<TrackedSignal>): TrackedSignal => ({
  id: Math.random().toString(36),
  pair: "EUR/USD",
  provider: "twelvedata",
  marketType: "LIVE",
  decision: "CALL",
  signalCandleTime: 0,
  entryRef: 1,
  mode: "V2",
  createdAt: Date.UTC(2026, 9, 13, 10),
  status: "RESOLVED",
  outcome: "WIN",
  ...over,
});

describe("today's tally (regression: forced Generate answers inflated/deflated the headline)", () => {
  const now = Date.UTC(2026, 9, 13, 12);
  const list = [
    sig({ outcome: "WIN" }),
    sig({ outcome: "LOSS", kind: "MANUAL", label: "Kamzor" }),
    sig({ outcome: "LOSS", mode: "NORMAL" }),
    sig({ outcome: "WIN", createdAt: Date.UTC(2026, 9, 12, 10) }),
  ];
  it("counts only today's rule-based signals of the selected mode", () => {
    expect(todaysTally(list, now, "V2")).toEqual({ wins: 1, losses: 0, ties: 0 });
    expect(todaysTally(list, now, "NORMAL")).toEqual({ wins: 0, losses: 1, ties: 0 });
  });
  it("feeds the monitor in chronological order, AUTO only", () => {
    const l = [sig({ signalCandleTime: 2, outcome: "LOSS" }), sig({ signalCandleTime: 1, outcome: "WIN" }), sig({ signalCandleTime: 3, kind: "MANUAL", outcome: "LOSS" })];
    expect(autoOutcomes(l, "V2")).toEqual(["WIN", "LOSS"]);
  });
});

describe("settings migration", () => {
  it("moves users saved before v3 to the v4 demo once (v2 lost on 2026 data)", () => {
    expect(migrateSettings({ mode: "NORMAL", sound: false, payoutPercent: 80, symbol: "GBP/USD" })).toMatchObject({ mode: "V4", sound: false, payoutPercent: 80, symbol: "GBP/USD", dailyLossLimit: 3 });
    expect(migrateSettings({ mode: "V2", settingsVersion: 2 }).mode).toBe("V4");
  });
  it("keeps a mode chosen after the migration", () => {
    expect(migrateSettings({ mode: "STRICT", settingsVersion: 3 }).mode).toBe("STRICT");
    expect(migrateSettings({ mode: "V2", settingsVersion: 3 }).mode).toBe("V2");
  });
  it("rejects unknown modes and bad loss limits", () => {
    expect(migrateSettings({ mode: "TURBO", settingsVersion: 3 }).mode).toBe("V4");
    expect(migrateSettings({ dailyLossLimit: -2, settingsVersion: 3 }).dailyLossLimit).toBe(3);
    expect(migrateSettings({ dailyLossLimit: 0, settingsVersion: 3 }).dailyLossLimit).toBe(0);
  });
});
