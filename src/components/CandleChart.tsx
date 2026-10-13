"use client";

import { useSyncExternalStore } from "react";
import type { ChartPayload } from "@/lib/api/contracts";
import { fmtPrice, fmtTime } from "@/lib/client/format";

const QUERY = "(max-width: 640px)";
const subscribe = (cb: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const useCompact = () => useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);

const PAD = { l: 8, r: 64, t: 12, b: 26 };

/** Lightweight SVG candlestick chart: closed candles only, with EMA, Bollinger and S/R zones. */
export function CandleChart({ chart: full, label }: { chart: ChartPayload; label: string }) {
  // On narrow screens show the most recent 40 candles in a taller frame so they stay legible.
  const compact = useCompact();
  const W = compact ? 520 : 900;
  const H = compact ? 420 : 380;
  const keep = compact ? 40 : full.candles.length;
  const cut = Math.max(0, full.candles.length - keep);
  const chart: ChartPayload = {
    ...full,
    candles: full.candles.slice(cut),
    emaFast: full.emaFast.slice(cut),
    emaSlow: full.emaSlow.slice(cut),
    bbUpper: full.bbUpper.slice(cut),
    bbLower: full.bbLower.slice(cut),
  };
  const { candles } = chart;
  const vals: number[] = [];
  candles.forEach((c) => vals.push(c.high, c.low));
  chart.bbUpper.forEach((v) => v !== null && vals.push(v));
  chart.bbLower.forEach((v) => v !== null && vals.push(v));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const padY = (hi - lo) * 0.06 || hi * 0.0005;
  lo -= padY;
  hi += padY;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const step = plotW / candles.length;
  const x = (i: number) => PAD.l + i * step + step / 2;
  const y = (p: number) => PAD.t + ((hi - p) / (hi - lo)) * plotH;
  const bodyW = Math.max(1.5, step * 0.62);

  const line = (s: (number | null)[]) => {
    let d = "";
    s.forEach((v, i) => {
      if (v === null) return;
      d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  };

  const ticks = Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / 5);
  const last = candles[candles.length - 1];
  const timeEvery = Math.max(1, Math.round(candles.length / 6));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label}>
      {chart.zones.map((z, i) => (
        <rect
          key={i}
          x={PAD.l}
          width={plotW}
          y={y(z.high)}
          height={Math.max(2, y(z.low) - y(z.high))}
          fill={z.kind === "SUPPORT" ? "rgba(63,220,160,0.10)" : "rgba(255,112,136,0.10)"}
          stroke={z.kind === "SUPPORT" ? "rgba(63,220,160,0.35)" : "rgba(255,112,136,0.35)"}
          strokeDasharray="4 4"
        />
      ))}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="rgba(150,195,255,0.07)" />
          <text x={W - PAD.r + 6} y={y(t) + 4} fontSize={compact ? 14 : 11} fill="#93A6BF">
            {fmtPrice(t)}
          </text>
        </g>
      ))}
      <path d={line(chart.bbUpper)} fill="none" stroke="rgba(76,141,255,0.45)" strokeDasharray="3 4" strokeWidth="1.2" />
      <path d={line(chart.bbLower)} fill="none" stroke="rgba(76,141,255,0.45)" strokeDasharray="3 4" strokeWidth="1.2" />
      {candles.map((c, i) => {
        const up = c.close >= c.open;
        const col = up ? "#3FDCA0" : "#FF7088";
        const top = y(Math.max(c.open, c.close));
        const h = Math.max(1, Math.abs(y(c.open) - y(c.close)));
        return (
          <g key={c.time}>
            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1" />
            <rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={h} fill={up ? "rgba(63,220,160,0.85)" : "rgba(255,112,136,0.85)"} rx="0.8" />
          </g>
        );
      })}
      <path d={line(chart.emaSlow)} fill="none" stroke="#4C8DFF" strokeWidth="1.6" />
      <path d={line(chart.emaFast)} fill="none" stroke="#56D4EC" strokeWidth="1.6" />
      {last && (
        <g>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(last.close)} y2={y(last.close)} stroke="rgba(231,238,248,0.35)" strokeDasharray="2 3" />
          <rect x={W - PAD.r + 2} y={y(last.close) - 9} width={PAD.r - 4} height={18} rx="4" fill="#E7EEF8" />
          <text x={W - PAD.r + 6} y={y(last.close) + 4} fontSize={compact ? 14 : 11} fontWeight="600" fill="#050A14">
            {fmtPrice(last.close)}
          </text>
        </g>
      )}
      {candles.map((c, i) =>
        i % timeEvery === 0 && i > 2 && i < candles.length - 3 ? (
          <text key={`t${c.time}`} x={x(i)} y={H - 8} fontSize={compact ? 14 : 11} fill="#93A6BF" textAnchor="middle">
            {fmtTime(c.time)}
          </text>
        ) : null,
      )}
    </svg>
  );
}
