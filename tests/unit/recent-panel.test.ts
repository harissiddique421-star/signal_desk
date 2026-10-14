import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const stat = (n: number, winRate: number, ci95: [number, number]) => ({ n, signals: n, winRate, ci95, net: 0, maxLosingStreak: 3 });

async function render(json: unknown) {
  vi.resetModules();
  vi.doMock("@/lib/research/recent.json", () => ({ default: json }));
  const { RecentPanel } = await import("@/components/simple/RecentPanel");
  return text(renderToStaticMarkup(createElement(RecentPanel)));
}

afterEach(() => vi.doUnmock("@/lib/research/recent.json"));

describe("RecentPanel", () => {
  it("explains how to run the test before it has run", async () => {
    const out = await render({ generatedAt: null, period: null, payout: 0.85, breakEven: 0.5405, opportunities: 0, v2: null, v3: null });
    expect(out).toContain("Abhi tak nahin chala");
    expect(out).toContain("TWELVEDATA_API_KEY");
  });

  it("shows the verdict, on-time and late win rates once results exist", async () => {
    const out = await render({
      generatedAt: "2026-10-17T03:30:00Z",
      period: { from: "2026-08-17T00:00:00Z", to: "2026-10-16T21:00:00Z" },
      payout: 0.85,
      breakEven: 0.5405,
      opportunities: 250000,
      v2: {
        onTime: stat(1200, 0.551, [0.523, 0.579]),
        late: stat(1190, 0.512, [0.484, 0.54]),
        verdict: { code: "UNPROVEN", text: "Naye data par pakka faida sabit nahin hota." },
        vsHistoricalTest: { historical: { winRate: 0.5561 }, diff: -0.0051, pValue: 0.76 },
        byPair: { "EUR/USD": stat(200, 0.55, [0.48, 0.62]) },
      },
      v3: {
        onTime: stat(300, 0.56, [0.5, 0.61]),
        late: stat(298, 0.52, [0.46, 0.57]),
        verdict: { code: "UNPROVEN", text: "Pakka nahin." },
        vsV2: { diff: 0.009, pValue: 0.78 },
      },
    });
    expect(out).toContain("Naye data par pakka faida sabit nahin hota.");
    expect(out).toContain("55.1%");
    expect(out).toContain("51.2%");
    expect(out).toContain("v3 ML (shadow)");
    expect(out).toContain("ittefaq ho sakta hai");
  });
});
