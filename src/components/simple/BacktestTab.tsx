"use client";

import { useState } from "react";
import { MODE_LABEL, type SignalMode } from "@/lib/config/presets";
import type { BacktestResponse } from "@/lib/api/contracts";
import { api } from "@/lib/client/api";
import { fmtPct, fmtTime } from "@/lib/client/format";
import { EquityLine } from "../Performance";
import { HistoryPanel } from "./HistoryPanel";
import { RecentPanel } from "./RecentPanel";

const PERIODS = [
  { label: "6 ghante", count: 360 },
  { label: "12 ghante", count: 720 },
  { label: "1 din", count: 1440 },
  { label: "3 din", count: 4320 },
];

export function BacktestTab({ provider, symbol, mode, payout, live }: { provider: string | null; symbol: string | null; mode: SignalMode; payout: number; live: boolean }) {
  const [count, setCount] = useState(1440);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BacktestResponse | null>(null);

  async function run() {
    if (!provider || !symbol) return;
    setBusy(true);
    setError(null);
    const r = await api<BacktestResponse>("/api/backtest", { method: "POST", json: { provider, symbol, marketType: "LIVE", payout, count, mode, inSampleFraction: 0.7 } });
    setBusy(false);
    if (r.ok) setData(r.data);
    else setError(r.error);
  }

  const o = data?.result.overall;
  const decided = o ? o.wins + o.losses : 0;
  const edge = o && o.winRateCi95 && o.winRateCi95[0] > o.breakEvenWinRate;
  const trades = data ? [...data.result.trades].reverse().slice(0, 25) : [];

  return (
    <section className="mt-5 space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Backtest</h2>
        <p className="mt-1 text-sm text-muted">
          {symbol ?? "Pair"} ke pichle data par yahi rules har minute chala kar dekhta hai ke kitne signal sahi hote. Har qadam par sirf us waqt tak ka data use hota hai.
        </p>
      </div>

      <RecentPanel />

      <HistoryPanel />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.count} aria-pressed={count === p.count} onClick={() => setCount(p.count)} className={`rounded-full border px-3.5 py-2 text-sm font-semibold ${count === p.count ? "border-cyan/60 bg-cyan/15" : "border-white/10 text-muted"}`}>
            {p.label}
          </button>
        ))}
      </div>
      <button className="btn btn-primary w-full" disabled={!provider || !symbol || busy} onClick={() => void run()}>
        {busy ? "Test ho raha hai…" : `${symbol ?? ""} par backtest chalayein (${MODE_LABEL[mode]})`}
      </button>
      {error && <p role="alert" className="text-sm text-put">{error}</p>}

      {data && o && (
        <div className="space-y-4">
          {data.synthetic && <p className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">Yeh sample (nakli) data hai — asli market ka nateeja nahin.</p>}
          <p className="text-sm text-muted">
            {fmtTime(data.result.firstCandle)} se {fmtTime(data.result.lastCandle)} tak, {data.result.candlesUsed} candles.
          </p>
          <div className="glass grid grid-cols-3 gap-2 p-4 text-center">
            <div>
              <p className="text-2xl font-semibold">{o.sampleSize}</p>
              <p className="text-xs text-muted">Signals</p>
            </div>
            <div>
              <p className="text-2xl font-semibold">
                <span className="text-call">{o.wins}</span>
                <span className="text-faint">/</span>
                <span className="text-put">{o.losses}</span>
              </p>
              <p className="text-xs text-muted">WIN / LOSS</p>
            </div>
            <div>
              <p className="text-2xl font-semibold">{fmtPct(o.winRate, 0)}</p>
              <p className="text-xs text-muted">Jeet ki sharah</p>
            </div>
          </div>
          <p className={`rounded-lg px-3 py-2 text-sm ${edge ? "bg-call/10 text-call" : "bg-white/5 text-ink"}`}>
            {decided === 0
              ? "Is period mein koi signal nahin bana."
              : edge
                ? `Is period mein jeet ${fmtPct(o.winRate, 0)} rahi, jo barabar rehne ki had ${fmtPct(o.breakEvenWinRate, 0)} se pakke taur par zyada hai.`
                : `Jeet ${fmtPct(o.winRate, 0)} rahi; ${payout * 100}% payout par barabar rehne ke liye ${fmtPct(o.breakEvenWinRate, 0)} chahiye. Is period mein pakka faida sabit nahin hota.`}{" "}
            Net: {o.netUnits > 0 ? "+" : ""}
            {o.netUnits.toFixed(1)} stake. Sab se lambi haar ki series: {o.maxLosingStreak}.
          </p>
          {data.result.overallLate && data.result.overallLate.wins + data.result.overallLate.losses > 0 && (
            <p className="text-sm text-muted" data-testid="late-entry">
              Agar entry ek candle der se lein: jeet {fmtPct(data.result.overallLate.winRate, 0)}, net {data.result.overallLate.netUnits > 0 ? "+" : ""}
              {data.result.overallLate.netUnits.toFixed(1)} stake. Asli entry (kuch second ki der) in dono ke darmiyan hoti hai.
            </p>
          )}
          {o.equityCurve.length > 1 && <EquityLine curve={o.equityCurve} label="Backtest ka cumulative nateeja" />}
          {trades.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">Aakhri signals</h3>
              <ul className="mt-2 space-y-1.5 text-sm">
                {trades.map((t) => (
                  <li key={t.signalCandleTime} className="flex justify-between border-b border-white/5 pb-1.5">
                    <span className="text-muted">{fmtTime(t.signalCandleTime + 60_000)}</span>
                    <span className={t.decision === "CALL" ? "text-call" : "text-put"}>{t.decision === "CALL" ? "▲ BUY" : "▼ SELL"}</span>
                    <span className={t.outcome === "WIN" ? "text-call" : t.outcome === "LOSS" ? "text-put" : "text-muted"}>{t.outcome}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-faint">Pichle nataij mustaqbil ki zamanat nahin. Spread aur Quotex ki apni price shamil nahin.</p>
        </div>
      )}
      {!live && <p className="text-xs text-faint">Live data band hai, is liye backtest sample data par chalega.</p>}
    </section>
  );
}
