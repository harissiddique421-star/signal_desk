"use client";

import { useState } from "react";
import type { BacktestResponse } from "@/lib/api/contracts";
import { api } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import type { MarketType } from "@/lib/types";
import { EquityLine, PerformanceStats } from "./Performance";

export function BacktestPanel({ provider, symbol, marketType, payout }: { provider: string | null; symbol: string | null; marketType: MarketType; payout: number }) {
  const [count, setCount] = useState(1500);
  const [split, setSplit] = useState(70);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BacktestResponse | null>(null);

  async function run() {
    if (!provider || !symbol) return;
    setBusy(true);
    setError(null);
    const r = await api<BacktestResponse>("/api/backtest", { method: "POST", json: { provider, symbol, marketType, payout, count, inSampleFraction: split / 100 } });
    setBusy(false);
    if (r.ok) setData(r.data);
    else setError(r.error);
  }

  const res = data?.result;
  const topReasons = res ? Object.entries(res.noTradeReasons).sort((a, b) => b[1] - a[1]).slice(0, 5) : [];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Walks forward one closed candle at a time using only data available at that moment. Entry is the next candle&apos;s open and expiry its close.
      </p>
      <p className="text-sm text-faint" lang="ur-Latn">Backtest purane data par qawaid (rules) aazmata hai. Pichle nataij mustaqbil ki zamanat nahin.</p>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label className="grid gap-1 text-sm">
          <span className="text-muted">Candles</span>
          <input className="field w-28" type="number" min={300} max={5000} step={100} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted">In-sample share (%)</span>
          <input className="field w-28" type="number" min={30} max={90} step={5} value={split} onChange={(e) => setSplit(Number(e.target.value))} />
        </label>
        <p className="pb-3 text-sm text-muted">Payout {Math.round(payout * 100)}% (change in Settings)</p>
        <button className="btn btn-primary" disabled={!provider || !symbol || busy} type="submit">
          {busy ? "Running backtest…" : `Run backtest on ${symbol ?? "a pair"}`}
        </button>
      </form>

      {error && <p role="alert" className="text-put">{error}</p>}

      {data && res && (
        <div className="space-y-5">
          <p role="status" className={`rounded-lg px-3 py-2 text-sm ${data.synthetic ? "bg-warn/10 text-warn" : "bg-cyan/10 text-cyan"}`}>
            {data.notice}
          </p>
          <p className="text-sm text-muted">
            {res.symbol} from {fmtDateTime(res.firstCandle)} to {fmtDateTime(res.lastCandle)}. {res.barsEvaluated} bars evaluated, {res.overall.sampleSize} trades, {res.noTradeBars} NO TRADE.
          </p>
          <PerformanceStats report={res.overall} title="All trades" />
          {res.overall.equityCurve.length > 1 && <EquityLine curve={res.overall.equityCurve} label="Cumulative backtest result in stakes" />}
          <div className="grid gap-5 lg:grid-cols-2">
            <PerformanceStats report={res.inSample} title={`In-sample (before ${fmtDateTime(res.splitTime)})`} />
            <PerformanceStats report={res.outOfSample} title="Out-of-sample" />
          </div>
          {topReasons.length > 0 && (
            <div>
              <h3 className="font-semibold">Most common reasons for NO TRADE</h3>
              <ul className="mt-2 space-y-1 text-sm text-muted">
                {topReasons.map(([k, v]) => (
                  <li key={k}>
                    {k}: {v} bars
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="font-semibold">Assumptions</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {res.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
