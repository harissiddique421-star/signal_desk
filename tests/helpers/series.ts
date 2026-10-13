import type { Candle } from "@/lib/types";

export const M = 60_000;
export const T0 = 1_760_000_040_000; // minute-aligned

/** Deterministic up-drifting wave used to exercise the full CALL path. */
export function upWave(n = 320, drift = 0.00004, amp = 0.00025, period = 16): Candle[] {
  const out: Candle[] = [];
  let prev = 1;
  for (let t = 0; t < n; t++) {
    const close = 1 + drift * t + amp * Math.sin((2 * Math.PI * t) / period);
    const open = prev;
    out.push({ time: T0 + t * M, open, high: Math.max(open, close) + 0.00005, low: Math.min(open, close) - 0.00005, close });
    prev = close;
  }
  return out;
}

/** Mirror a series around 1.0 (bullish ↔ bearish). */
export function mirror(c: Candle[]): Candle[] {
  return c.map((x) => ({ time: x.time, open: 2 - x.open, close: 2 - x.close, high: 2 - x.low, low: 2 - x.high }));
}

export const afterClose = (c: Candle[], ms = 1000) => c[c.length - 1].time + M + ms;
