import { describe, expect, it } from "vitest";
import { classifyPixel, readChart, type PixelImage, type ScreenCandle } from "@/lib/screen/read-chart";
import { screenSignal } from "@/lib/screen/screen-signal";

const GREEN = [15, 175, 89];
const RED = [219, 73, 49];
const BG = [22, 27, 45];

function canvas(W: number, H: number): PixelImage & { fill: (x0: number, y0: number, x1: number, y1: number, c: number[]) => void } {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) data.set([...BG, 255], p * 4);
  return {
    width: W,
    height: H,
    data,
    fill(x0, y0, x1, y1, c) {
      for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) data.set([...c, 255], (y * W + x) * 4);
    },
  };
}

interface Spec {
  open: number;
  close: number;
  high: number;
  low: number;
}

/** Draw candles (prices as screen heights from the bottom), plus UI clutter. */
function draw(specs: Spec[], W = 800, H = 400) {
  const img = canvas(W, H);
  const step = 12;
  specs.forEach((s, i) => {
    const cx = 40 + i * step;
    const c = s.close >= s.open ? GREEN : RED;
    const y = (v: number) => H - v;
    img.fill(cx, y(s.high), cx, y(s.low), c); // wick
    img.fill(cx - 3, y(Math.max(s.open, s.close)), cx + 3, y(Math.min(s.open, s.close)), c); // body
  });
  // clutter: a wide green UP button, a red DOWN button, small green "text", a red dashed price line
  img.fill(W - 150, 40, W - 10, 90, GREEN);
  img.fill(W - 150, 110, W - 10, 160, RED);
  for (let t = 0; t < 4; t++) img.fill(W - 140 + t * 9, 200, W - 136 + t * 9, 207, GREEN);
  for (let x = 30; x < W - 160; x += 10) img.fill(x, 120, x + 5, 120, RED);
  return img;
}

function trendSpecs(n: number, dir: 1 | -1): Spec[] {
  const out: Spec[] = [];
  let p = 200;
  for (let i = 0; i < n; i++) {
    const up = dir > 0 ? i % 4 !== 3 : i % 4 === 3;
    const o = p;
    const c = up ? o + 6 : o - 6;
    out.push({ open: o, close: c, high: Math.max(o, c) + 3, low: Math.min(o, c) - 3 });
    p = c;
  }
  return out;
}

describe("screen chart reader", () => {
  it("classifies candle colours and ignores background/grey", () => {
    expect(classifyPixel(GREEN[0], GREEN[1], GREEN[2])).toBe(1);
    expect(classifyPixel(RED[0], RED[1], RED[2])).toBe(2);
    expect(classifyPixel(BG[0], BG[1], BG[2])).toBe(0);
    expect(classifyPixel(140, 140, 150)).toBe(0);
  });

  it("reads every candle, in order, with the right colour and OHLC, and skips the clutter", () => {
    const specs = trendSpecs(40, 1);
    const r = readChart(draw(specs));
    expect(r.candles).toHaveLength(40);
    r.candles.forEach((c: ScreenCandle, i) => {
      const s = specs[i];
      expect(c.color).toBe(s.close >= s.open ? "GREEN" : "RED");
      expect(c.close - c.open).toBeCloseTo(s.close - s.open, -1);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    });
  });

  it("returns nothing useful for an image without candles", () => {
    expect(readChart(canvas(300, 200)).candles).toHaveLength(0);
  });
});

describe("screen signal", () => {
  it("UP on a rising chart, DOWN on a falling one", () => {
    // 39 candles: the series ends on a with-trend candle, not on a pullback
    const up = screenSignal(readChart(draw(trendSpecs(39, 1))).candles)!;
    const down = screenSignal(readChart(draw(trendSpecs(39, -1))).candles)!;
    expect(up.direction).toBe("UP");
    expect(down.direction).toBe("DOWN");
    expect(up.reasons.length).toBeGreaterThan(0);
  });

  it("a tweezer top at the high of a rally turns the vote to DOWN", () => {
    const s = screenSignal(readChart(draw(trendSpecs(40, 1))).candles)!;
    expect(s.patterns).toContain("tweezer top");
    expect(s.direction).toBe("DOWN");
  });

  it("reads a bullish engulfing at the end", () => {
    const specs = trendSpecs(30, -1);
    const p = specs[specs.length - 1].close;
    specs.push({ open: p, close: p - 5, high: p + 1, low: p - 6 }); // small red
    specs.push({ open: p - 6, close: p + 4, high: p + 5, low: p - 7 }); // big green engulfing
    const s = screenSignal(readChart(draw(specs)).candles)!;
    expect(s.patterns.some((n) => n.includes("engulfing"))).toBe(true);
  });

  it("needs a few candles before it answers", () => {
    expect(screenSignal([])).toBeNull();
  });
});
