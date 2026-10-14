import { describe, expect, it } from "vitest";
import { isFxWeekendClosed } from "@/lib/analysis/market-hours";
import { evaluateSignal } from "@/lib/engine/signal";
import { afterClose, upWave } from "../helpers/series";

const at = (iso: string) => Date.parse(iso);

describe("isFxWeekendClosed", () => {
  it("is open on weekdays and closed from Friday 21:00 to Sunday 22:00 UTC", () => {
    expect(isFxWeekendClosed(at("2026-10-14T10:00:00Z"))).toBe(false); // Wednesday
    expect(isFxWeekendClosed(at("2026-10-16T20:59:00Z"))).toBe(false); // Friday before close
    expect(isFxWeekendClosed(at("2026-10-16T21:00:00Z"))).toBe(true); // Friday close
    expect(isFxWeekendClosed(at("2026-10-17T12:00:00Z"))).toBe(true); // Saturday
    expect(isFxWeekendClosed(at("2026-10-18T21:30:00Z"))).toBe(true); // Sunday, before the wide reopen
    expect(isFxWeekendClosed(at("2026-10-18T22:00:00Z"))).toBe(false); // Sunday reopen
    expect(isFxWeekendClosed(at("2026-10-19T00:00:00Z"))).toBe(false); // Monday
  });
});

describe("engine market-hours gate", () => {
  const src = { id: "test", name: "Test feed", verified: true, supportedMarketTypes: ["LIVE" as const] };
  const bull = upWave().slice(0, 155);

  it("returns NO_TRADE on weekend candles from a live feed", () => {
    // Same candles moved to a Saturday.
    const shift = at("2026-10-17T10:00:00Z") - bull[0].time;
    const sat = bull.map((c) => ({ ...c, time: c.time + shift }));
    const r = evaluateSignal({ candles: sat, symbol: "EUR/USD", marketType: "LIVE", symbolSupported: true, source: src, analysisKind: "LIVE_FEED", now: afterClose(sat) });
    expect(r.decision).toBe("NO_TRADE");
    expect(r.checks.find((c) => c.id === "data.marketHours")?.passed).toBe(false);
  });

  it("passes the gate on weekday candles", () => {
    const r = evaluateSignal({ candles: bull, symbol: "EUR/USD", marketType: "LIVE", symbolSupported: true, source: src, analysisKind: "LIVE_FEED", now: afterClose(bull) });
    expect(r.checks.find((c) => c.id === "data.marketHours")?.passed).toBe(true);
  });
});
