import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Route handlers call connection()/cookies(), which need a Next request scope. Stub them for unit tests.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

import { AnalyzeRequestSchema, BacktestRequestSchema, JournalCreateSchema, JournalOutcomeSchema, LoginSchema } from "@/lib/api/schemas";
import { RateLimiter, clientKey } from "@/lib/server/rate-limit";
import { checkScreenshotDimensions, sniffImage } from "@/lib/validation/image";

let ipCounter = 0;
const req = (url: string, init?: RequestInit) =>
  new Request(`http://localhost${url}`, { ...init, headers: { "x-forwarded-for": `10.0.0.${++ipCounter % 250}`, ...(init?.headers ?? {}) } });
const post = (url: string, body: unknown) => req(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("request schemas", () => {
  it("accepts a valid analyze request and rejects extra fields / bad symbols", () => {
    expect(AnalyzeRequestSchema.safeParse({ provider: "twelvedata", symbol: "EUR/USD", marketType: "LIVE" }).success).toBe(true);
    expect(AnalyzeRequestSchema.safeParse({ provider: "twelvedata", symbol: "EUR/USD", marketType: "LIVE", apikey: "x" }).success).toBe(false);
    expect(AnalyzeRequestSchema.safeParse({ provider: "twelvedata", symbol: "EUR/USD; DROP", marketType: "LIVE" }).success).toBe(false);
    expect(AnalyzeRequestSchema.safeParse({ provider: "twelvedata", symbol: "EUR/USD", marketType: "CRYPTO" }).success).toBe(false);
  });
  it("validates rule overrides strictly", () => {
    expect(AnalyzeRequestSchema.safeParse({ provider: "sample", symbol: "SAMPLE-TREND", marketType: "LIVE", rules: { minAgreement: 0.6 } }).success).toBe(true);
    expect(AnalyzeRequestSchema.safeParse({ provider: "sample", symbol: "SAMPLE-TREND", marketType: "LIVE", rules: { minAgreement: 7 } }).success).toBe(false);
    expect(AnalyzeRequestSchema.safeParse({ provider: "sample", symbol: "SAMPLE-TREND", marketType: "LIVE", rules: { evil: 1 } }).success).toBe(false);
  });
  it("bounds backtest parameters", () => {
    expect(BacktestRequestSchema.safeParse({ provider: "sample", symbol: "SAMPLE-TREND", marketType: "LIVE", payout: 0.85 }).success).toBe(true);
    expect(BacktestRequestSchema.safeParse({ provider: "sample", symbol: "SAMPLE-TREND", marketType: "LIVE", payout: 85 }).success).toBe(false);
    expect(BacktestRequestSchema.safeParse({ provider: "sample", symbol: "SAMPLE-TREND", marketType: "LIVE", payout: 0.8, count: 100000 }).success).toBe(false);
  });
  it("journal entries must be demo and 60s expiry", () => {
    const base = {
      source: "Twelve Data", pair: "EUR/USD", marketType: "LIVE", analysisKind: "LIVE_FEED", decision: "CALL", engineDecision: "CALL",
      signalCandleTime: "2026-10-13T09:30:00.000Z", entryReference: 1.1, expirySeconds: 60, agreementScore: 0.5, ruleVersion: "rules-v1", evidence: [], reasons: [],
    };
    expect(JournalCreateSchema.safeParse(base).success).toBe(true);
    expect(JournalCreateSchema.safeParse({ ...base, expirySeconds: 300 }).success).toBe(false);
    expect(JournalCreateSchema.safeParse({ ...base, isDemo: false }).success).toBe(false);
    expect(JournalOutcomeSchema.safeParse({ outcome: "WIN" }).success).toBe(true);
    expect(JournalOutcomeSchema.safeParse({ outcome: "MAYBE" }).success).toBe(false);
    expect(LoginSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });
});

describe("rate limiter", () => {
  it("blocks after the limit within a window and resets next window", () => {
    let t = 1_000_000_020_000;
    const rl = new RateLimiter(2, 60_000, () => t);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
    expect(rl.check("b").allowed).toBe(true);
    t += 60_000;
    expect(rl.check("a").allowed).toBe(true);
  });
  it("derives the client key from the first forwarded address", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientKey(new Headers())).toBe("unknown");
  });
});

describe("image sniffing", () => {
  function png(w: number, h: number) {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const dv = new DataView(b.buffer);
    dv.setUint32(16, w);
    dv.setUint32(20, h);
    return b;
  }
  it("reads PNG dimensions from magic bytes", () => {
    expect(sniffImage(png(1080, 2340))).toEqual({ kind: "image/png", width: 1080, height: 2340 });
  });
  it("reads JPEG SOF dimensions", () => {
    const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(b)).toEqual({ kind: "image/jpeg", width: 800, height: 600 });
  });
  it("rejects non-images and tiny images", () => {
    expect(sniffImage(new TextEncoder().encode("<script>alert(1)</script> padding padding"))).toBeNull();
    expect(checkScreenshotDimensions({ kind: "image/png", width: 100, height: 100 })).toMatch(/at least/);
    expect(checkScreenshotDimensions({ kind: "image/png", width: 1080, height: 2340 })).toBeNull();
  });
});

describe("route handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("TWELVEDATA_API_KEY", "");
    vi.stubEnv("ENABLE_SAMPLE_PROVIDER", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("health reports live data unavailable without a provider key", async () => {
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    expect(body.liveDataAvailable).toBe(false);
    expect(body.otcDataAvailable).toBe(false);
    expect(body.providers.find((p: { id: string }) => p.id === "twelvedata").status).toBe("NOT_CONFIGURED");
    expect(JSON.stringify(body)).not.toMatch(/apikey|secret/i);
  });

  it("analyze: 400 on invalid body, 400 on malformed JSON, 503 for unconfigured provider", async () => {
    const { POST } = await import("@/app/api/analyze/route");
    expect((await POST(post("/api/analyze", { provider: "sample" }))).status).toBe(400);
    expect((await POST(post("/api/analyze", "{not json"))).status).toBe(400);
    const r = await POST(post("/api/analyze", { provider: "twelvedata", symbol: "EUR/USD", marketType: "LIVE" }));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/live data unavailable/);
  });

  it("analyze on sample data is never tradable", async () => {
    const { POST } = await import("@/app/api/analyze/route");
    const r = await POST(post("/api/analyze", { provider: "sample", symbol: "SAMPLE-TREND", marketType: "LIVE" }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.decision).toBe("NO_TRADE");
    expect(body.result.analysisKind).toBe("SAMPLE");
    expect(body.result.reasons[0]).toMatch(/not a verified live market feed/);
  });

  it("analyze: unknown symbol → NO_TRADE with reason, not an error", async () => {
    const { POST } = await import("@/app/api/analyze/route");
    const body = await (await POST(post("/api/analyze", { provider: "sample", symbol: "EUR/USD", marketType: "LIVE" }))).json();
    expect(body.result.decision).toBe("NO_TRADE");
    expect(body.result.reasons.join(" ")).toMatch(/not offered/);
  });

  it("analyze: rate limited per client", async () => {
    vi.stubEnv("RATE_LIMIT_PER_MINUTE", "2");
    const { POST } = await import("@/app/api/analyze/route");
    const mk = () => new Request("http://localhost/api/analyze", { method: "POST", body: "{}", headers: { "x-forwarded-for": "9.9.9.9" } });
    await POST(mk());
    await POST(mk());
    expect((await POST(mk())).status).toBe(429);
  });

  it("journal requires accounts to be configured", async () => {
    const { GET } = await import("@/app/api/journal/route");
    const { NextRequest } = await import("next/server");
    const r = await GET(new NextRequest("http://localhost/api/journal"));
    expect(r.status).toBe(503);
  });

  it("screenshot: rejects spoofed type, accepts valid PNG and says interpretation is not implemented", async () => {
    const { POST } = await import("@/app/api/screenshot/route");
    const fake = new FormData();
    fake.set("file", new File([new TextEncoder().encode("not really a png at all, just text bytes")], "x.png", { type: "image/png" }));
    expect((await POST(req("/api/screenshot", { method: "POST", body: fake }))).status).toBe(415);

    const b = new Uint8Array(64);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, 1080);
    new DataView(b.buffer).setUint32(20, 2340);
    const ok = new FormData();
    ok.set("file", new File([b], "chart.png", { type: "image/png" }));
    ok.set("marketType", "OTC");
    const r = await POST(req("/api/screenshot", { method: "POST", body: ok }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ interpretation: "NOT_IMPLEMENTED", decision: "NO_TRADE", stored: false, marketType: "OTC" });
  });

  it("backtest on sample data is flagged synthetic", async () => {
    const { POST } = await import("@/app/api/backtest/route");
    const r = await POST(post("/api/backtest", { provider: "sample", symbol: "SAMPLE-TREND", marketType: "LIVE", payout: 0.8, count: 400 }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.synthetic).toBe(true);
    expect(body.notice).toMatch(/SYNTHETIC/);
  });
});
