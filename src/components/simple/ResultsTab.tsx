"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { fmtPct, fmtPrice, fmtTime } from "@/lib/client/format";
import type { TrackedSignal } from "@/lib/client/signals-store";
import { summarize } from "@/lib/stats/performance";
import type { Resolution } from "@/lib/stats/resolve";

type Range = "today" | "all";

export function ResultsTab(props: {
  tracked: TrackedSignal[];
  setTracked: (fn: (list: TrackedSignal[]) => TrackedSignal[]) => void;
  payout: number;
  now: number;
  live: boolean;
}) {
  const { tracked, setTracked, payout, now, live } = props;
  const [range, setRange] = useState<Range>("today");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const list = useMemo(
    () => (range === "today" ? tracked.filter((t) => new Date(t.createdAt).toDateString() === new Date(now).toDateString()) : tracked),
    [tracked, range, now],
  );
  const report = useMemo(() => summarize(list.map((t) => ({ time: t.createdAt, outcome: t.outcome ?? "UNRESOLVED" })), payout), [list, payout]);

  // Settle pending signals (for any pair) whose trade candle has closed.
  const settle = useCallback(async () => {
    if (!live) return;
    const due = tracked.filter((t) => t.status === "PENDING" && Date.now() > t.signalCandleTime + 125_000);
    if (!due.length) return;
    setBusy(true);
    const byPair = new Map<string, TrackedSignal[]>();
    for (const t of due) byPair.set(`${t.provider}|${t.pair}`, [...(byPair.get(`${t.provider}|${t.pair}`) ?? []), t]);
    let failed = 0;
    for (const [key, items] of byPair) {
      const [provider, pair] = key.split("|");
      const r = await api<{ results: ({ id: string } & Resolution)[] }>("/api/resolve", {
        method: "POST",
        json: { provider, symbol: pair, marketType: "LIVE", signals: items.slice(0, 50).map((t) => ({ id: t.id, signalCandleTime: t.signalCandleTime, decision: t.decision })) },
      });
      if (!r.ok) {
        failed++;
        continue;
      }
      const map = new Map(r.data.results.map((x) => [x.id, x]));
      setTracked((all) =>
        all.map((t) => {
          const x = map.get(t.id);
          return x && x.status !== "PENDING" ? { ...t, status: x.status, outcome: x.outcome, entry: x.entry, exit: x.exit } : t;
        }),
      );
    }
    setBusy(false);
    setMsg(failed ? "Kuch results abhi check nahin ho sake — thori dair baad dobara koshish hogi." : null);
  }, [tracked, setTracked, live]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- settle once on open, then every 2 minutes
    void settle();
    const t = setInterval(() => void settle(), 120_000);
    return () => clearInterval(t);
    // run on mount only; settle reads the latest list each time it is recreated
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decided = report.wins + report.losses;

  return (
    <section className="mt-5 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Results</h2>
        <div className="seg" role="group" aria-label="Range">
          <button aria-pressed={range === "today"} onClick={() => setRange("today")}>
            Aaj
          </button>
          <button aria-pressed={range === "all"} onClick={() => setRange("all")}>
            Sab
          </button>
        </div>
      </div>

      <div className="glass grid grid-cols-3 gap-2 p-4 text-center">
        <div>
          <p className="text-2xl font-semibold text-call">{report.wins}</p>
          <p className="text-xs text-muted">WIN</p>
        </div>
        <div>
          <p className="text-2xl font-semibold text-put">{report.losses}</p>
          <p className="text-xs text-muted">LOSS</p>
        </div>
        <div>
          <p className="text-2xl font-semibold">{decided ? fmtPct(report.winRate, 0) : "—"}</p>
          <p className="text-xs text-muted">Jeet ki sharah</p>
        </div>
        <p className="col-span-3 mt-2 text-xs text-faint">
          {report.ties} tie, {report.unresolved} pending. {payout * 100}% payout par barabar rehne ke liye {fmtPct(report.breakEvenWinRate)} chahiye. Net: {report.netUnits > 0 ? "+" : ""}
          {report.netUnits.toFixed(2)} trade-stake.
        </p>
      </div>

      <p className="text-xs text-faint">
        Nateeja live feed ki agli candle se khud nikalta hai (entry = candle ka open, expiry = close). Quotex ki price thori mukhtalif ho sakti hai, is liye apne demo trade se bhi milayein.
        {decided < 30 && decided > 0 ? " Abhi trades kam hain — itne se andaza pakka nahin." : ""}
      </p>
      {busy && <p className="text-sm text-muted">Results check ho rahe hain…</p>}
      {msg && <p className="text-sm text-warn">{msg}</p>}

      {list.length === 0 ? (
        <p className="glass-quiet p-4 text-sm text-muted">Abhi koi BUY/SELL signal nahin aaya. Signal screen khuli rakhein — signal aate hi yahan dikhega aur 2 minute baad uska nateeja.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((t) => (
            <li key={t.id} className="glass-quiet flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-semibold">
                  <span className={t.decision === "CALL" ? "text-call" : "text-put"}>{t.decision === "CALL" ? "▲ BUY" : "▼ SELL"}</span> {t.pair}
                </p>
                <p className="text-xs text-muted">
                  {fmtTime(t.signalCandleTime + 60_000)} entry{t.entry ? `, ${fmtPrice(t.entry)} → ${fmtPrice(t.exit)}` : t.entryRef ? `, ~${fmtPrice(t.entryRef)}` : ""}
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-bold ${
                  t.outcome === "WIN" ? "bg-call/15 text-call" : t.outcome === "LOSS" ? "bg-put/15 text-put" : t.outcome === "TIE" ? "bg-white/10 text-ink" : "bg-white/5 text-muted"
                }`}
              >
                {t.outcome ?? (t.status === "UNAVAILABLE" ? "N/A" : "Pending")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {tracked.length > 0 && (
        <button
          className="text-xs text-faint underline"
          onClick={() => {
            if (window.confirm("Saare results mita dein?")) setTracked(() => []);
          }}
        >
          History saaf karein
        </button>
      )}
    </section>
  );
}
