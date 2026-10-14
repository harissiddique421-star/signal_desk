/**
 * Reads green/red candlesticks from a chart screenshot (e.g. a Quotex chart), in the
 * browser, without any AI service. It finds candle-coloured blobs, keeps the longest
 * evenly spaced row of them (the candle series) and turns each blob into OHLC values
 * in pixel units (higher on screen = higher price).
 *
 * Limits: needs a candlestick chart with green (up) and red (down) candles on a dark or
 * light background. Line/area charts, other colours or heavy overlays are not read.
 */

export interface PixelImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row */
  data: Uint8ClampedArray | Uint8Array;
}

export type CandleColor = "GREEN" | "RED";

export interface ScreenCandle {
  /** centre x in pixels */
  x: number;
  color: CandleColor;
  open: number;
  high: number;
  low: number;
  close: number;
  /** bounding box in image pixels, for drawing an overlay */
  box: { x0: number; y0: number; x1: number; y1: number };
}

export interface ChartRead {
  candles: ScreenCandle[];
  /** typical distance between candle centres, pixels */
  spacing: number;
  /** coloured blobs found before choosing the candle row */
  blobs: number;
  detail: string;
}

/** 0 = neither, 1 = green, 2 = red */
export function classifyPixel(r: number, g: number, b: number): 0 | 1 | 2 {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 70 || max - min < 45) return 0; // too dark or greyish (background, grid, text)
  if (g >= r + 35 && g >= b + 10) return 1;
  if (r >= g + 45 && r >= b + 25) return 2;
  return 0;
}

interface Blob {
  color: 1 | 2;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  count: number;
  label: number;
}

export function readChart(img: PixelImage): ChartRead {
  const { width: W, height: H, data } = img;
  const mask = new Uint8Array(W * H);
  for (let p = 0, q = 0; p < W * H; p++, q += 4) mask[p] = classifyPixel(data[q], data[q + 1], data[q + 2]);

  // ---- connected components (4-neighbour), per colour ---------------------------
  const labels = new Int32Array(W * H);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    const color = mask[start];
    if (!color || labels[start]) continue;
    const label = blobs.length + 1;
    const b: Blob = { color: color as 1 | 2, x0: W, x1: -1, y0: H, y1: -1, count: 0, label };
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      b.count++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      const visit = (q: number) => {
        if (mask[q] === color && !labels[q]) {
          labels[q] = label;
          stack.push(q);
        }
      };
      if (x > 0) visit(p - 1);
      if (x < W - 1) visit(p + 1);
      if (y > 0) visit(p - W);
      if (y < H - 1) visit(p + W);
    }
    blobs.push(b);
  }

  // ---- merge a wick that got separated from its body (same colour, same column) --
  const merged: Blob[][] = [];
  const sorted = blobs.filter((b) => b.count >= 2).sort((a, b) => a.x0 - b.x0);
  for (const b of sorted) {
    const host = merged.find((g) => {
      const h = g[0];
      const ov = Math.min(h.x1, b.x1) - Math.max(h.x0, b.x0) + 1;
      const minW = Math.min(h.x1 - h.x0 + 1, b.x1 - b.x0 + 1);
      const gap = Math.max(b.y0 - groupY1(g), groupY0(g) - b.y1);
      return h.color === b.color && ov >= Math.max(1, 0.5 * minW) && gap <= 3;
    });
    if (host) host.push(b);
    else merged.push([b]);
  }

  // ---- candle shape filter --------------------------------------------------------
  const maxW = Math.max(6, Math.round(0.06 * W));
  type Cand = { group: Blob[]; color: 1 | 2; x0: number; x1: number; y0: number; y1: number; bodyTop: number; bodyBottom: number; bodyW: number; cx: number };
  const cands: Cand[] = [];
  for (const g of merged) {
    const x0 = Math.min(...g.map((b) => b.x0));
    const x1 = Math.max(...g.map((b) => b.x1));
    const y0 = groupY0(g);
    const y1 = groupY1(g);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w < 2 || w > maxW || h < 3 || h > 0.85 * H) continue;
    const ids = new Set(g.map((b) => b.label));
    // row widths → body = the rows at (nearly) full width; wick = thin rows
    const rowW: number[] = [];
    for (let y = y0; y <= y1; y++) {
      let n = 0;
      for (let x = x0; x <= x1; x++) if (ids.has(labels[y * W + x])) n++;
      rowW.push(n);
    }
    const full = Math.max(...rowW);
    if (full < 2) continue;
    const thr = Math.max(2, Math.ceil(0.6 * full));
    let top = -1;
    let bottom = -1;
    rowW.forEach((n, i) => {
      if (n >= thr) {
        if (top < 0) top = i;
        bottom = i;
      }
    });
    const count = g.reduce((s, b) => s + b.count, 0);
    if (count / (w * h) < 0.12) continue; // outlines / sparse text
    cands.push({ group: g, color: g[0].color, x0, x1, y0, y1, bodyTop: y0 + top, bodyBottom: y0 + bottom, bodyW: full, cx: (x0 + x1) / 2 });
  }
  if (cands.length < 3) return { candles: [], spacing: 0, blobs: blobs.length, detail: `Only ${cands.length} candle-like shapes found` };

  // ---- choose the longest evenly spaced row with similar body widths -------------
  cands.sort((a, b) => a.cx - b.cx);
  const dx: number[] = [];
  for (let i = 1; i < cands.length; i++) {
    const d = cands[i].cx - cands[i - 1].cx;
    if (d >= 2) dx.push(d);
  }
  const spacing = mode(dx);
  let best: Cand[] = [];
  for (let s = 0; s < cands.length; s++) {
    const chain = [cands[s]];
    for (let j = s + 1; j < cands.length; j++) {
      const last = chain[chain.length - 1];
      const d = cands[j].cx - last.cx;
      if (d < 0.6 * spacing) continue; // overlapping / noise at the same x
      if (d > 2.6 * spacing) break; // gap too big: series ended
      const wRatio = cands[j].bodyW / median(chain.map((c) => c.bodyW));
      if (wRatio < 0.5 || wRatio > 2) continue;
      chain.push(cands[j]);
    }
    if (chain.length > best.length) best = chain;
  }

  const candles: ScreenCandle[] = best.map((c) => {
    const up = c.color === 1;
    // price axis: up on screen = higher price
    const hi = H - c.y0;
    const lo = H - c.y1;
    const bodyHi = H - c.bodyTop;
    const bodyLo = H - c.bodyBottom;
    return {
      x: c.cx,
      color: up ? "GREEN" : "RED",
      open: up ? bodyLo : bodyHi,
      close: up ? bodyHi : bodyLo,
      high: hi,
      low: lo,
      box: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
    };
  });
  return { candles, spacing, blobs: blobs.length, detail: `${candles.length} candles read (${cands.length} candle-like shapes, spacing ${spacing.toFixed(1)} px)` };
}

function groupY0(g: Blob[]) {
  return Math.min(...g.map((b) => b.y0));
}
function groupY1(g: Blob[]) {
  return Math.max(...g.map((b) => b.y1));
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Most common value (rounded to whole pixels); falls back to the median. */
function mode(v: number[]): number {
  if (!v.length) return 0;
  const counts = new Map<number, number>();
  for (const d of v) {
    const k = Math.round(d);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [k, n] of counts) {
    // neighbours count too, so 9/10/11 px spacings vote together
    const near = n + (counts.get(k - 1) ?? 0) + (counts.get(k + 1) ?? 0);
    if (near > bestN || (near === bestN && k < best)) {
      best = k;
      bestN = near;
    }
  }
  return bestN > 1 ? best : median(v);
}
