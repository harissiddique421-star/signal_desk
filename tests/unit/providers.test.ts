import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { generateSampleCandles, SampleProvider } from "@/lib/providers/sample";
import { parseTimeSeries, parseUtcDatetime, TwelveDataProvider } from "@/lib/providers/twelvedata";
import { ProviderError } from "@/lib/providers/types";
import { inspectSeries } from "@/lib/validation/candles";

const M = 60_000;

describe("sample provider", () => {
  const now = 1_760_000_000_000 + 30_000;
  it("is deterministic and minute-aligned, ending with the forming candle", () => {
    const a = generateSampleCandles("SAMPLE-TREND", now, 200);
    const b = generateSampleCandles("SAMPLE-TREND", now, 200);
    expect(a).toEqual(b);
    expect(a.length).toBe(200);
    expect(a[a.length - 1].time).toBe(Math.floor(now / M) * M);
    expect(inspectSeries(a, M, 200).ok).toBe(true);
  });
  it("is marked unverified and refuses unknown symbols", async () => {
    const p = new SampleProvider(() => now);
    expect(p.verified).toBe(false);
    await expect(p.getCandles({ symbol: "EUR/USD", marketType: "LIVE", count: 10 })).rejects.toBeInstanceOf(ProviderError);
    expect((await p.listSymbols("OTC")).every((s) => s.symbol.startsWith("SAMPLE-"))).toBe(true);
  });
});

describe("Twelve Data parsing", () => {
  const ok = {
    meta: { symbol: "EUR/USD", interval: "1min", currency_base: "Euro", type: "Physical Currency" },
    values: [
      { datetime: "2026-10-13 09:31:00", open: "1.10010", high: "1.10030", low: "1.10000", close: "1.10020" },
      { datetime: "2026-10-13 09:30:00", open: "1.10000", high: "1.10020", low: "1.09990", close: "1.10010" },
    ],
    status: "ok",
  };
  it("parses UTC datetimes", () => {
    expect(parseUtcDatetime("2026-10-13 09:31:00")).toBe(Date.UTC(2026, 9, 13, 9, 31));
    expect(parseUtcDatetime("2026-10-13 09:31")).toBe(Date.UTC(2026, 9, 13, 9, 31));
  });
  it("parses and sorts values ascending with numeric prices", () => {
    const c = parseTimeSeries(ok, "EUR/USD");
    expect(c.map((x) => x.time)).toEqual([Date.UTC(2026, 9, 13, 9, 30), Date.UTC(2026, 9, 13, 9, 31)]);
    expect(c[1].close).toBe(1.1002);
  });
  it("rejects wrong symbol, wrong interval and malformed bodies", () => {
    expect(() => parseTimeSeries(ok, "GBP/USD")).toThrow(/different symbol/);
    expect(() => parseTimeSeries({ ...ok, meta: { ...ok.meta, interval: "5min" } }, "EUR/USD")).toThrow(/different interval/);
    expect(() => parseTimeSeries({ hello: 1 }, "EUR/USD")).toThrow(/expected format/);
    expect(() => parseTimeSeries({ ...ok, values: [{ ...ok.values[0], datetime: "yesterday" }] }, "EUR/USD")).toThrow();
  });
  it("maps provider errors to safe messages", () => {
    expect(() => parseTimeSeries({ status: "error", code: 401, message: "secret detail" }, "EUR/USD")).toThrow("Market data API key rejected");
    try {
      parseTimeSeries({ status: "error", code: 429, message: "x" }, "EUR/USD");
    } catch (e) {
      expect((e as ProviderError).status).toBe(429);
    }
  });
});

describe("Twelve Data adapter", () => {
  it("reports NOT_CONFIGURED without a key and makes no request", async () => {
    const f = vi.fn();
    const p = new TwelveDataProvider(undefined, f as unknown as typeof fetch);
    expect(p.isConfigured()).toBe(false);
    expect((await p.health()).status).toBe("NOT_CONFIGURED");
    await expect(p.getCandles({ symbol: "EUR/USD", marketType: "LIVE", count: 10 })).rejects.toThrow(/not configured/);
    expect(f).not.toHaveBeenCalled();
  });
  it("refuses OTC and builds the documented request", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ meta: { symbol: "EUR/USD", interval: "1min" }, values: [] }), { status: 200 }));
    const p = new TwelveDataProvider("test-key-123456", f as unknown as typeof fetch);
    await expect(p.getCandles({ symbol: "EUR/USD", marketType: "OTC", count: 10 })).rejects.toThrow(/OTC/);
    await p.getCandles({ symbol: "EUR/USD", marketType: "LIVE", count: 200 });
    const url = new URL(String((f.mock.calls[0] as unknown[])[0]));
    expect(url.origin + url.pathname).toBe("https://api.twelvedata.com/time_series");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ symbol: "EUR/USD", interval: "1min", outputsize: "200", timezone: "UTC", order: "asc" });
  });
  it("marks itself DEGRADED after a failed request, with a safe message", async () => {
    const f = vi.fn(async () => new Response("upstream body with secrets", { status: 500 }));
    const p = new TwelveDataProvider("test-key-123456", f as unknown as typeof fetch);
    await expect(p.getCandles({ symbol: "EUR/USD", marketType: "LIVE", count: 10 })).rejects.toThrow("Market data provider HTTP 500");
    const h = await p.health();
    expect(h.status).toBe("DEGRADED");
    expect(h.detail).not.toMatch(/secrets/);
  });
});
