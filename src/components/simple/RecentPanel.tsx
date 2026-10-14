"use client";

import { fmtDateTime } from "@/lib/client/format";

interface Stat {
  n: number;
  signals: number;
  winRate: number | null;
  ci95: [number, number] | null;
  net: number;
  maxLosingStreak: number;
}
interface Verdict {
  code: "EDGE" | "UNPROVEN" | "LOSING" | "TOO_FEW";
  text: string;
}
interface Recent {
  data?: Record<string, { feed?: { continuousOpenShare: number | null; medianGapToRange?: number | null } }>;
  sourceId?: string;
  liveFeed?: boolean;
  generatedAt: string | null;
  period: { from: string; to: string } | null;
  payout: number;
  breakEven: number;
  opportunities: number;
  v2: { onTime: Stat; late: Stat; verdict: Verdict; vsHistoricalTest: { historical: { winRate: number }; diff: number; pValue: number } | null; byPair: Record<string, Stat> } | null;
  v3: { onTime: Stat; late: Stat; verdict: Verdict; vsV2: { diff: number; pValue: number } | null } | null;
}

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(d)}%`);
const tone: Record<Verdict["code"], string> = {
  EDGE: "bg-call/10 text-call",
  LOSING: "bg-put/10 text-put",
  UNPROVEN: "bg-warn/10 text-warn",
  TOO_FEW: "bg-white/5 text-muted",
};

/**
 * The shipped rules re-run on recent candles from the live provider
 * (scripts/research/recent-test.ts, run by the "Recent data test" GitHub Action).
 * Answers: does the 2018–2020 edge still exist on today's market?
 */
export function RecentPanel({ json, title, emptyHint }: { json: unknown; title: string; emptyHint: string }) {
  const r = json as Recent;
  if (!r.v2 || !r.period) {
    return (
      <section className="glass-quiet p-4 text-sm" data-testid="recent-panel">
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-muted">{emptyHint}</p>
      </section>
    );
  }
  const v2 = r.v2;
  const v3 = r.v3;
  // Median jump between a candle's close and the next candle's open, as a share of the
  // candle's range. Tick-built candles open within a tick or two of the previous close;
  // Twelve Data measured ~0.3, i.e. its consecutive candles are not a continuous price series.
  const gaps = Object.values(r.data ?? {})
    .map((d) => d.feed?.medianGapToRange)
    .filter((x): x is number => typeof x === "number");
  const feedSuspect = gaps.length > 0 && gaps.reduce((a, b) => a + b, 0) / gaps.length > 0.15;
  const row = (label: string, s: Stat, late: Stat) => (
    <tr className="border-t border-white/5 align-top">
      <td className="py-1.5 pr-2">{label}</td>
      <td>{s.n.toLocaleString()}</td>
      <td className={s.ci95 && s.ci95[0] > r.breakEven ? "text-call" : (s.winRate ?? 1) < r.breakEven ? "text-put" : ""}>
        {pct(s.winRate)}
        {s.ci95 ? ` (${pct(s.ci95[0], 0)}–${pct(s.ci95[1], 0)})` : ""}
      </td>
      <td className={(late.winRate ?? 1) < r.breakEven ? "text-put" : ""}>{pct(late.winRate)}</td>
    </tr>
  );
  return (
    <section className="glass-quiet p-4 text-sm" data-testid="recent-panel">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-muted">
        {fmtDateTime(r.period.from)} se {fmtDateTime(r.period.to)} tak · Twelve Data (wohi feed jo app live use karti hai) · {r.opportunities.toLocaleString()} moqay · barabar ke liye {pct(r.breakEven)} chahiye.
      </p>
      <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${tone[v2.verdict.code]}`}>v2: {v2.verdict.text}</p>
      {feedSuspect && (
        <p className="mt-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn" data-testid="feed-warning">
          Is feed ki candles lagatar price nahin dikhatin: agli candle pichli candle ke close se shuru nahin hoti. Is wajah se yeh nateeja feed ki banawat se bigda ho sakta hai. Signal ulta kar ke trade na karein — yeh bhi isi bigaad ka nateeja hoga.
        </p>
      )}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-normal">Version</th>
              <th className="font-normal">Trades</th>
              <th className="font-normal">Jeet (95%)</th>
              <th className="font-normal">Der se</th>
            </tr>
          </thead>
          <tbody>
            {row("v2 Fade", v2.onTime, v2.late)}
            {v3 && row("v3 ML (shadow)", v3.onTime, v3.late)}
          </tbody>
        </table>
      </div>
      {v2.vsHistoricalTest && (
        <p className="mt-2 text-xs text-muted">
          2020 ke test ({pct(v2.vsHistoricalTest.historical.winRate)}) se farq: {v2.vsHistoricalTest.diff > 0 ? "+" : ""}
          {pct(v2.vsHistoricalTest.diff)} — {v2.vsHistoricalTest.pValue < 0.05 ? "yeh farq ittefaq nahin lagta" : "yeh farq ittefaq ho sakta hai"} (p = {v2.vsHistoricalTest.pValue.toFixed(2)}).
        </p>
      )}
      {v3 && v3.vsV2 && (
        <p className="mt-1 text-xs text-muted">
          v3 ML: {v3.verdict.text} v2 se farq {v3.vsV2.diff > 0 ? "+" : ""}
          {pct(v3.vsV2.diff)} (p = {v3.vsV2.pValue.toFixed(2)}). v3 tab tak sirf shadow mein rahega jab tak yeh pakka behtar na ho.
        </p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-cyan">Pair ke hisaab se (v2)</summary>
        <ul className="mt-1 space-y-0.5 text-xs text-muted">
          {Object.entries(v2.byPair).map(([k, v]) => (
            <li key={k}>
              {k}: {pct(v.winRate)} ({v.n})
            </li>
          ))}
        </ul>
      </details>
      <p className="mt-2 text-xs text-faint">
        Har hafte khud update hota hai. Spread aur Quotex ki apni price shamil nahin; asli entry (kuch second der) &quot;on time&quot; aur &quot;der se&quot; ke darmiyan hoti hai. Last update: {r.generatedAt ? fmtDateTime(r.generatedAt) : "—"}.
      </p>
    </section>
  );
}
