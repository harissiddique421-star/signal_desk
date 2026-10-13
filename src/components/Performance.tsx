"use client";

import type { PerformanceReport } from "@/lib/stats/performance";
import { fmtPct, fmtUnits } from "@/lib/client/format";

export function EquityLine({ curve, label }: { curve: number[]; label: string }) {
  if (curve.length < 2) return null;
  const W = 600;
  const H = 120;
  const pts = [0, ...curve];
  const lo = Math.min(0, ...pts);
  const hi = Math.max(0, ...pts);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => 6 + ((hi - v) / span) * (H - 12);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const end = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" role="img" aria-label={label} preserveAspectRatio="none">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="rgba(150,195,255,0.25)" strokeDasharray="3 4" />
      <path d={d} fill="none" stroke={end >= 0 ? "#3FDCA0" : "#FF7088"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function PerformanceStats({ report, title }: { report: PerformanceReport; title?: string }) {
  const decided = report.wins + report.losses;
  const rows: [string, string, string?][] = [
    ["Decided trades", String(decided), `${report.ties} ties, ${report.unresolved} unresolved`],
    ["Win rate", fmtPct(report.winRate), report.winRateCi95 ? `95% range ${fmtPct(report.winRateCi95[0], 0)}–${fmtPct(report.winRateCi95[1], 0)}` : undefined],
    ["Break-even win rate", fmtPct(report.breakEvenWinRate), `at ${(report.payout * 100).toFixed(0)}% payout`],
    ["Net result", `${fmtUnits(report.netUnits)} stakes`, report.expectancyPerTrade !== null ? `${fmtUnits(report.expectancyPerTrade)} per trade` : undefined],
    ["Longest losing streak", String(report.maxLosingStreak)],
    ["Max drawdown", `${report.maxDrawdownUnits.toFixed(2)} stakes`],
  ];
  return (
    <div>
      {title && <h3 className="font-semibold">{title}</h3>}
      <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {rows.map(([k, v, sub]) => (
          <div key={k} className="glass-quiet px-3 py-2.5">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="text-lg font-semibold">{v}</dd>
            {sub && <dd className="text-xs text-faint">{sub}</dd>}
          </div>
        ))}
      </dl>
      <ul className="mt-3 space-y-1 text-xs text-muted">
        {report.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}
