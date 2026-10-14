"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { fmtPct, fmtPrice, fmtTime } from "@/lib/client/format";
import { autoOutcomes, opportunityStore, V4_DEMO_TARGET, v4DemoProgress, versionComparison, type TrackedSignal } from "@/lib/client/signals-store";
import { wilson } from "@/lib/stats/performance";
import { MODE_LABEL, SIGNAL_MODES, type SignalMode } from "@/lib/config/presets";
import { assessStrategyHealth } from "@/lib/stats/monitor";
import { summarize } from "@/lib/stats/performance";
import type { Resolution } from "@/lib/stats/resolve";

type Range = "today" | "all";

export function ResultsTab(props: {
  tracked: TrackedSignal[];
  setTracked: (fn: (list: TrackedSignal[]) => TrackedSignal[]) => void;
  payout: number;
  now: number;
  live: boolean;
  mode: SignalMode;
}) {
  const { tracked, setTracked, payout, now, live, mode } = props;
  const [range, setRange] = useState<Range>("today");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const list = useMemo(
    () => (range === "today" ? tracked.filter((t) => new Date(t.createdAt).toDateString() === new Date(now).toDateString()) : tracked),
    [tracked, range, now],
  );
  // Headline = rule-based (AUTO) signals of the selected strategy only. Other versions and the
  // old forced Generate answers are listed separately below so they cannot blur the headline.
  const headline = useMemo(() => list.filter((t) => (t.kind ?? "AUTO") === "AUTO" && t.mode === mode), [list, mode]);
  const report = useMemo(() => summarize(headline.map((t) => ({ time: t.createdAt, outcome: t.outcome ?? "UNRESOLVED" })), payout), [headline, payout]);
  const health = useMemo(() => assessStrategyHealth(autoOutcomes(tracked, mode), payout), [tracked, mode, payout]);
  const [opps, setOpps] = useState<Record<string, number>>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read browser storage after mount
    setOpps(opportunityStore.load());
  }, [tracked]);
  const comparison = useMemo(() => versionComparison(tracked, opps), [tracked, opps]);
  const visible = useMemo(() => list.filter((t) => t.kind !== "SHADOW"), [list]);

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
  const groups: [string, TrackedSignal[]][] = [
    ...SIGNAL_MODES.map((m): [string, TrackedSignal[]] => [MODE_LABEL[m], list.filter((t) => (t.kind ?? "AUTO") === "AUTO" && t.mode === m)]),
    ["Purana Generate (zabardasti direction)", list.filter((t) => t.kind === "MANUAL")],
  ].filter(([, items]) => items.length > 0) as [string, TrackedSignal[]][];

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

      <V4DemoCard tracked={tracked} payout={payout} />

      <p className="text-xs text-muted">Upar ke numbers: sirf {MODE_LABEL[mode]} ke auto signals.</p>
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
          {report.winRateCi95 && decided >= 20 ? `95% yaqeeni range ${fmtPct(report.winRateCi95[0], 0)}–${fmtPct(report.winRateCi95[1], 0)}. ` : ""}
          {report.ties} tie, {report.unresolved} pending. {payout * 100}% payout par barabar rehne ke liye {fmtPct(report.breakEvenWinRate)} chahiye. Net: {report.netUnits > 0 ? "+" : ""}
          {report.netUnits.toFixed(2)} trade-stake.
        </p>
      </div>

      <p className={`text-sm ${health.status === "DEGRADED" ? "text-put" : health.status === "WATCH" ? "text-warn" : "text-muted"}`} data-testid="strategy-health">
        Strategy ki sehat: {health.detailUr}
      </p>

      {groups.length > 0 && (
        <div className="glass-quiet divide-y divide-white/5 text-sm">
          {groups.map(([name, items]) => {
            const w = items.filter((t) => t.outcome === "WIN").length;
            const l = items.filter((t) => t.outcome === "LOSS").length;
            return (
              <div key={name} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-muted">{name}</span>
                <span>
                  <span className="text-call">{w}</span>/<span className="text-put">{l}</span>
                  <span className="ml-2 font-semibold">{w + l ? `${Math.round((w / (w + l)) * 100)}%` : "—"}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-faint">
        Nateeja live feed ki agli candle se khud nikalta hai (entry = candle ka open, expiry = close). Aap 5–15 second baad entry lete hain aur Quotex ki apni price hoti hai, is liye asli nateeja mukhtalif ho sakta hai — apne demo trade se zaroor milayein. Research mein ek minute der se entry par v2 ki jeet 55.6% se gir kar 51.5% reh gayi thi.
        {decided < 30 && decided > 0 ? " Abhi trades kam hain — itne se andaza pakka nahin." : ""}
      </p>
      {busy && <p className="text-sm text-muted">Results check ho rahe hain…</p>}
      {msg && <p className="text-sm text-warn">{msg}</p>}

      <p className="text-xs text-muted" data-testid="market-split">
        LIVE: {tracked.filter((t) => t.marketType === "LIVE" && t.kind !== "SHADOW" && t.kind !== "MANUAL").length} signal · OTC: {tracked.filter((t) => t.marketType === "OTC").length} signal — OTC ka koi jaiz data feed nahi, is liye OTC par signal nahi diya jaata.
      </p>

      <div className="glass-quiet p-4 text-sm" data-testid="shadow-compare">
        <h3 className="font-semibold">v2 vs v3 (shadow) — live muqabla</h3>
        <p className="mt-1 text-xs text-muted">
          Dono versions har live minute par chalte hain. Jo version active nahin, uske signal sirf yahan gine jaate hain — aapko alert nahin aata. v3 tabhi kaam ka mana jaye jab yahan kam az kam 200 nataij ke baad bhi v2 se behtar ho.
        </p>
        <table className="mt-2 w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-normal">Version</th>
              <th className="font-normal">Moqay</th>
              <th className="font-normal">Signal</th>
              <th className="font-normal">W/L</th>
              <th className="font-normal">Jeet (95%)</th>
            </tr>
          </thead>
          <tbody>
            {comparison.map((r) => {
              const ci = wilson(r.wins, r.wins + r.losses);
              return (
                <tr key={r.version} className="border-t border-white/5">
                  <td className="py-1.5">{r.label}</td>
                  <td>{r.opportunities}</td>
                  <td>
                    {r.signals}
                    {r.coverage !== null ? ` (${(r.coverage * 100).toFixed(1)}%)` : ""}
                  </td>
                  <td>
                    <span className="text-call">{r.wins}</span>/<span className="text-put">{r.losses}</span>
                  </td>
                  <td>{r.wins + r.losses ? `${fmtPct(r.wins / (r.wins + r.losses), 0)}${ci && r.wins + r.losses >= 20 ? ` (${fmtPct(ci[0], 0)}–${fmtPct(ci[1], 0)})` : ""}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {visible.length === 0 ? (
        <p className="glass-quiet p-4 text-sm text-muted">Abhi koi BUY/SELL signal nahin aaya. Signal screen khuli rakhein — signal aate hi yahan dikhega aur 2 minute baad uska nateeja.</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((t) => (
            <li key={t.id} className="glass-quiet flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-semibold">
                  <span className={t.decision === "CALL" ? "text-call" : "text-put"}>{t.decision === "CALL" ? "▲ BUY" : "▼ SELL"}</span> {t.pair}
                  {t.kind === "MANUAL" && <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted">{t.label ?? "Generate"}</span>}
                </p>
                <p className="text-xs text-muted">
                  {fmtTime(t.signalCandleTime + 60_000)} entry → {fmtTime(t.signalCandleTime + 120_000)} expiry
                  {t.entry ? `, ${fmtPrice(t.entry)} → ${fmtPrice(t.exit)}` : t.entryRef ? `, ~${fmtPrice(t.entryRef)}` : ""}
                </p>
                <p className="text-[11px] text-faint">
                  {t.marketType} · {t.provider} · {t.ruleVersion ?? t.mode} · signal {fmtTime(t.createdAt, true)}
                </p>
                {(t.kind ?? "AUTO") === "AUTO" && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[11px]" role="group" aria-label="Quotex par asli nateeja">
                    <span className="text-muted">Quotex:</span>
                    {(["WIN", "LOSS", "TIE"] as const).map((o) => (
                      <button
                        key={o}
                        aria-pressed={t.quotexOutcome === o}
                        onClick={() => setTracked((all) => all.map((x) => (x.id === t.id ? { ...x, quotexOutcome: x.quotexOutcome === o ? undefined : o } : x)))}
                        className={`rounded-full border px-2 py-0.5 ${t.quotexOutcome === o ? (o === "WIN" ? "border-call/60 bg-call/15 text-call" : o === "LOSS" ? "border-put/60 bg-put/15 text-put" : "border-white/30 bg-white/10") : "border-white/10 text-muted"}`}
                      >
                        {o === "TIE" ? "Barabar" : o}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-bold ${
                  t.outcome === "WIN" ? "bg-call/15 text-call" : t.outcome === "LOSS" ? "bg-put/15 text-put" : t.outcome === "TIE" ? "bg-white/10 text-ink" : "bg-white/5 text-muted"
                }`}
              >
                {t.outcome ? `${t.outcome}${t.quotexOutcome ? "" : " (feed)"}` : t.status === "UNAVAILABLE" ? "N/A" : "Pending"}
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

/**
 * Forward test of v4 on the user's Quotex DEMO account. Counts only results the user
 * entered from Quotex; the feed's own WIN/LOSS is not trusted (docs/RESEARCH.md §11).
 */
function V4DemoCard({ tracked, payout }: { tracked: TrackedSignal[]; payout: number }) {
  const p = v4DemoProgress(tracked, payout);
  if (p.signals === 0) return null;
  const pct = Math.min(100, Math.round((p.n / V4_DEMO_TARGET) * 100));
  const text =
    p.verdict === "EDGE"
      ? "Demo par jeet break-even se pakke taur par upar rahi. Asli paisa sirf chhoti raqam aur rozana had ke saath — aur nataij dekhte rahein."
      : p.verdict === "LOSING"
        ? "Demo par v4 break-even se pakke taur par neeche hai. Ise band karein; asli paisa na lagayein."
        : p.verdict === "UNPROVEN"
          ? "300 trades ke baad bhi faida saabit nahin hua. Asli paisa na lagayein."
          : `Abhi ${p.n}/${V4_DEMO_TARGET} demo trades. Itne se pehle koi faisla nahin — asli paisa na lagayein.`;
  return (
    <section className="glass-quiet p-4 text-sm" data-testid="v4-demo-progress">
      <h3 className="font-semibold">v4 Demo forward test</h3>
      <p className="mt-1 text-xs text-muted">
        Har v4 signal par Quotex demo ka asli nateeja (WIN / LOSS) neeche dabayein. Sirf wahi gine jaate hain — app ka apna feed wala andaza nahin.
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
        <div className="h-full bg-cyan" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2">
        {p.n}/{V4_DEMO_TARGET} trades · <span className="text-call">{p.wins} WIN</span> / <span className="text-put">{p.losses} LOSS</span>
        {p.winRate !== null && (
          <>
            {" "}
            · jeet {fmtPct(p.winRate, 1)}
            {p.ci && p.n >= 30 ? ` (${fmtPct(p.ci[0], 0)}–${fmtPct(p.ci[1], 0)})` : ""} · zaroorat {fmtPct(p.breakEven, 1)}
          </>
        )}
      </p>
      {p.signals > p.marked && <p className="mt-1 text-xs text-warn">{p.signals - p.marked} v4 signals ka Quotex nateeja abhi darj nahin.</p>}
      <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${p.verdict === "EDGE" ? "bg-call/10 text-call" : p.verdict === "LOSING" ? "bg-put/10 text-put" : "bg-white/5 text-muted"}`}>{text}</p>
    </section>
  );
}
