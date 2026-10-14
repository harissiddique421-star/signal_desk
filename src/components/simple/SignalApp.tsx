"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AnalyzeResponse, HealthResponse, SymbolsResponse } from "@/lib/api/contracts";
import { api } from "@/lib/client/api";
import { fmtPrice, fmtTime } from "@/lib/client/format";
import { autoOutcomes, dailyStopActive, DEFAULT_SIMPLE, localDayKey, opportunityStore, simpleSettingsStore, todaysTally, trackedStore, type SimpleSettings, type TrackedSignal } from "@/lib/client/signals-store";
import { MODE_LABEL, SIGNAL_MODES } from "@/lib/config/presets";
import { assessStrategyHealth } from "@/lib/stats/monitor";
import { agreementCount, CHECK_TEXT, evidenceChips, onlyTimingFailed, waitReason } from "@/lib/client/simple-text";
import { playSignalTone, unlockAudio } from "@/lib/client/sound";
import { feedStatsStore, msUntilFirstScan, recordFeedOutcome, SCAN_MAX_ATTEMPTS, SCAN_RETRY_MS, type FeedStats } from "@/lib/client/scan-timing";
import { resolveSignal } from "@/lib/stats/resolve";
import type { ProviderSymbol } from "@/lib/types";
import { CandleChart } from "../CandleChart";
import { ResultsTab } from "./ResultsTab";
import { BacktestTab } from "./BacktestTab";
import { ScreenTab } from "./ScreenTab";

type Tab = "signal" | "screen" | "results" | "backtest" | "more";


export function SignalApp() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(0);
  const [online, setOnline] = useState(true);
  const [settings, setSettings] = useState<SimpleSettings>(DEFAULT_SIMPLE);
  const [symbols, setSymbols] = useState<ProviderSymbol[]>([]);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [nextScanAt, setNextScanAt] = useState<number | null>(null);
  const [tracked, setTracked] = useState<TrackedSignal[]>([]);
  const [tab, setTab] = useState<Tab>("signal");
  const [showChart, setShowChart] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const loaded = useRef(false);
  const lastAlerted = useRef<string | null>(null);
  const lastShadowMinute = useRef<string | null>(null);

  // ---- bootstrap ---------------------------------------------------------------
  const loadHealth = useCallback(async () => {
    const t0 = Date.now();
    const r = await api<HealthResponse>("/api/health");
    if (r.ok) {
      setHealth(r.data);
      setHealthError(null);
      setOffset(r.data.serverTime - (t0 + Date.now()) / 2);
    } else setHealthError(r.error);
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time hydration from browser storage */
    setSettings(simpleSettingsStore.load());
    setTracked(trackedStore.load());
    setOnline(navigator.onLine);
    setNow(Date.now());
    /* eslint-enable react-hooks/set-state-in-effect */
    loaded.current = true;
    void loadHealth();
    const tick = setInterval(() => setNow(Date.now()), 500);
    const h = setInterval(() => void loadHealth(), 120_000);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    // Browsers only allow sound after a user gesture: unlock audio on the first tap anywhere.
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      clearInterval(tick);
      clearInterval(h);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [loadHealth]);

  useEffect(() => {
    if (loaded.current) simpleSettingsStore.save(settings);
  }, [settings]);
  useEffect(() => {
    if (loaded.current) trackedStore.save(tracked);
  }, [tracked]);

  const provider = useMemo(() => {
    const usable = (health?.providers ?? []).filter((p) => p.status !== "NOT_CONFIGURED" && p.supportedMarketTypes.includes("LIVE"));
    return usable.find((p) => p.verified) ?? usable[0] ?? null;
  }, [health]);
  const live = !!provider?.verified;
  // Say WHY live data is off, so a missing key is not mistaken for a closed market.
  const liveOffReason = useMemo(() => {
    const td = health?.providers.find((p) => p.id === "twelvedata");
    if (!td) return null;
    if (td.status === "NOT_CONFIGURED") return "Wajah: server par Twelve Data ki API key (TWELVEDATA_API_KEY) set nahin. Market khula ho tab bhi isi liye sample dikh raha hai. Vercel → Settings → Environment Variables mein key add karke Redeploy karein.";
    if (td.status === "DEGRADED") return `Wajah: Twelve Data se data nahin aa raha (${td.detail}).`;
    return null;
  }, [health]);

  // ---- symbols -----------------------------------------------------------------
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    (async () => {
      const r = await api<SymbolsResponse>(`/api/symbols?provider=${provider.id}&marketType=LIVE`);
      if (cancelled) return;
      if (r.ok) {
        setSymbols(r.data.symbols);
        setSymbolsError(null);
        setSettings((s) => (s.symbol && r.data.symbols.some((x) => x.symbol === s.symbol) ? s : { ...s, symbol: r.data.symbols[0]?.symbol ?? null }));
      } else setSymbolsError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const symbol = settings.symbol;
  const quick = symbols.slice(0, 9);
  const symbolMeta = symbols.find((s) => s.symbol === symbol);

  // ---- settle pending signals from candles we already have -------------------------
  const settleLocal = useCallback((resp: AnalyzeResponse) => {
    if (!resp.chart) return;
    const candles = resp.chart.candles;
    const at = resp.result.analyzedAt;
    setTracked((list) =>
      list.map((t) => {
        if (t.status !== "PENDING" || t.pair !== resp.result.symbol) return t;
        const r = resolveSignal(candles, t.signalCandleTime, t.decision, at);
        return r.status === "PENDING" ? t : { ...t, status: r.status, outcome: r.outcome, entry: r.entry, exit: r.exit };
      }),
    );
  }, []);

  // ---- degradation monitor: pause signals when recent results are clearly below break-even ----
  const stratHealth = useMemo(() => assessStrategyHealth(autoOutcomes(tracked, settings.mode), settings.payoutPercent / 100), [tracked, settings.mode, settings.payoutPercent]);
  const healthPaused = stratHealth.status === "DEGRADED" && !settings.ignoreHealth;
  // Daily loss stop (follows the clock state, so it also lifts after midnight).
  const dailyStop = now > 0 && dailyStopActive(tracked, now, settings);
  const paused = healthPaused || dailyStop;
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // ---- live scan loop: every minute, 4 s after the candle closes ---------------
  const scanOnce = useCallback(async (): Promise<AnalyzeResponse | null> => {
    if (!provider || !symbol) return null;
    setScanning(true);
    const r = await api<AnalyzeResponse>("/api/analyze", { method: "POST", json: { provider: provider.id, symbol, marketType: "LIVE", mode: settings.mode } });
    setScanning(false);
    if (!r.ok) {
      setError(r.error);
      return null;
    }
    setError(null);
    setAnalysis(r.data);
    settleLocal(r.data);
    const res = r.data.result;
    if (res.decision !== "NO_TRADE" && res.analysisKind === "LIVE_FEED" && res.signalCandleTime && !pausedRef.current) {
      const id = `${res.symbol}-${res.signalCandleTime}`;
      setTracked((list) =>
        list.some((t) => t.id === id)
          ? list
          : [
              {
                id,
                pair: res.symbol,
                provider: provider.id,
                marketType: "LIVE",
                decision: res.decision as "CALL" | "PUT",
                signalCandleTime: res.signalCandleTime!,
                entryRef: res.entryReference,
                mode: settings.mode,
                ruleVersion: res.ruleVersion,
                kind: "AUTO",
                createdAt: res.analyzedAt,
                status: "PENDING",
              },
              ...list,
            ],
      );
      if (settings.sound && lastAlerted.current !== id) {
        lastAlerted.current = id;
        playSignalTone(res.decision as "CALL" | "PUT");
      }
    }
    // Shadow mode: record what the other version would have done on the same minute (never alerted).
    if (res.analysisKind === "LIVE_FEED" && res.signalCandleTime && r.data.shadow) {
      const minuteKey = `${res.symbol}-${res.signalCandleTime}`;
      if (lastShadowMinute.current !== minuteKey) {
        lastShadowMinute.current = minuteKey;
        const opps = opportunityStore.load();
        for (const sh of r.data.shadow) if (sh.eligible) opps[sh.version] = (opps[sh.version] ?? 0) + 1;
        opportunityStore.save(opps);
      }
      const activeVersion = res.ruleVersion;
      const extra = r.data.shadow.filter((sh) => sh.decision !== "NO_TRADE" && sh.version !== activeVersion);
      if (extra.length) {
        setTracked((list) => {
          const add = extra
            .map((sh) => ({
              id: `${res.symbol}-${res.signalCandleTime}-${sh.version}`,
              pair: res.symbol,
              provider: provider.id,
              marketType: "LIVE" as const,
              decision: sh.decision as "CALL" | "PUT",
              signalCandleTime: res.signalCandleTime!,
              entryRef: res.entryReference,
              mode: settings.mode,
              ruleVersion: sh.version,
              kind: "SHADOW" as const,
              createdAt: res.analyzedAt,
              status: "PENDING" as const,
            }))
            .filter((t) => !list.some((x) => x.id === t.id));
          return add.length ? [...add, ...list] : list;
        });
      }
    }
    return r.data;
  }, [provider, symbol, settings.mode, settings.sound, settleLocal]);

  // ---- "Check now": same rules as the auto scan, on demand. It never forces a direction:
  // the old Generate button always answered UP or DOWN, and on 3.87 M historical minutes
  // those forced answers were right 48.5–49.8 % of the time (a coin flip, minus the payout).
  const checkNow = useCallback(async () => {
    setCheckBusy(true);
    await scanOnce();
    setCheckBusy(false);
  }, [scanOnce]);

  const scanRef = useRef(scanOnce);
  useEffect(() => {
    scanRef.current = scanOnce;
  }, [scanOnce]);

  useEffect(() => {
    if (!provider || !symbol || !online) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const serverNow = Date.now() + offset;
      const delay = msUntilFirstScan(serverNow, settings.mode);
      setNextScanAt(Date.now() + delay);
      timer = setTimeout(() => void run(1), delay);
    };
    const run = async (attempt: number) => {
      const res = await scanRef.current();
      if (cancelled) return;
      const late = res?.result.checks.some((c) => c.id === "data.freshness" && !c.passed);
      if (late && attempt < SCAN_MAX_ATTEMPTS) {
        setNextScanAt(Date.now() + SCAN_RETRY_MS);
        timer = setTimeout(() => void run(attempt + 1), SCAN_RETRY_MS);
        return;
      }
      // Record how quickly the feed delivered the finished candle (shown under More → Feed timing).
      if (res && res.result.analysisKind === "LIVE_FEED") feedStatsStore.save(recordFeedOutcome(feedStatsStore.load(), late ? null : attempt));
      schedule();
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the pair or mode changes
    setAnalysis(null);
    void run(1);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [provider, symbol, settings.mode, online, offset]);

  // ---- derived -----------------------------------------------------------------
  const serverNow = now + offset;
  const result = analysis?.result ?? null;
  const tradable = result && result.decision !== "NO_TRADE";
  const windowLeft = result?.entryWindowEnd && now ? Math.ceil((result.entryWindowEnd - serverNow) / 1000) : null;
  const expired = tradable && windowLeft !== null && windowLeft <= 0;
  const showSignal = tradable && !expired && !paused;
  // Seconds until the trade candle starts (FAST gives the signal before it opens).
  const startsIn = showSignal && result?.entryWindowStart && now ? Math.ceil((result.entryWindowStart - serverNow) / 1000) : null;
  const early = startsIn !== null && startsIn > 0;
  const verdict: "BUY" | "SELL" | "WAIT" = showSignal ? (result!.decision === "CALL" ? "BUY" : "SELL") : "WAIT";
  const nextIn = nextScanAt && now ? Math.max(0, Math.ceil((nextScanAt - now) / 1000)) : null;
  const { wins, losses } = todaysTally(tracked, serverNow, settings.mode);

  const theme = {
    BUY: { color: "#3FDCA0", glow: "rgba(63,220,160,0.22)", border: "rgba(63,220,160,0.55)", arrow: "▲" },
    SELL: { color: "#FF7088", glow: "rgba(255,112,136,0.22)", border: "rgba(255,112,136,0.55)", arrow: "▼" },
    WAIT: { color: "#A9B7CA", glow: "rgba(150,195,255,0.08)", border: "rgba(150,195,255,0.18)", arrow: "" },
  }[verdict];

  let subline = "";
  let reason = "";
  if (!provider) {
    subline = healthError ? "Server se rabta nahin ho raha" : "Data source dhoondh rahe hain…";
  } else if (!result) {
    subline = scanning ? "Market analyse ho rahi hai…" : error ? "Analysis nahin ho saka" : "Shuru ho raha hai…";
  } else if (tradable && paused) {
    subline = dailyStop ? "Signal mila, lekin aaj ki haar ki had poori ho chuki" : "Signal mila, lekin strategy abhi ruki hui hai";
    reason = dailyStop ? "Aaj mazeed trade na lein. Kal phir dekhein." : CHECK_TEXT["health.degraded"];
  } else if (showSignal) {
    const demo = settings.mode === "V4" || settings.mode === "FAST" ? "DEMO account par: " : "";
    const side = verdict === "BUY" ? "UP (CALL)" : "DOWN (PUT)";
    subline = early ? `${demo}Agli candle par ${side} — tayyar rahein` : demo + `Quotex par ${side} — 1 minute expiry`;
    if (early) reason = `Trade ${fmtTime(result.entryWindowStart)} wali candle par lena hai, us ke shuru hote hi entry karein.`;
  } else if (expired) {
    subline = `${result.decision === "CALL" ? "BUY" : "SELL"} signal tha, lekin entry ka waqt nikal gaya`;
    reason = "Agli candle ka intezar karein.";
  } else {
    subline = "Abhi trade na lein";
    reason = onlyTimingFailed(result.checks) ? "Agli candle close hone par dobara check hoga." : waitReason(result);
  }

  // The indicator-agreement bar describes the v1 trend rules; a v2 fade deliberately trades against them.
  const agree = result && result.evidence.length && (settings.mode === "STRICT" || settings.mode === "NORMAL") ? agreementCount(result) : null;
  const chips = showSignal && result ? evidenceChips(result.evidence, result.decision === "CALL" ? "BULLISH" : "BEARISH").slice(0, 6) : [];

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col px-4 pt-4 pb-24">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="24" height="24" viewBox="0 0 30 30" aria-hidden="true">
            <rect x="3" y="15" width="6" height="10" rx="1.5" fill="#4C8DFF" />
            <rect x="12" y="9" width="6" height="12" rx="1.5" fill="#56D4EC" />
            <rect x="21" y="4" width="6" height="11" rx="1.5" fill="#56D4EC" />
          </svg>
          <h1 className="text-lg font-semibold" style={{ fontStretch: "85%" }}>
            Signal Desk
          </h1>
        </div>
        <div className="flex items-center gap-2 text-sm" role="status">
          <span className={`h-2.5 w-2.5 rounded-full ${!online ? "bg-put" : live ? "animate-pulse bg-call" : "bg-warn"}`} aria-hidden="true" />
          <span>{!online ? "Offline" : live ? "Live" : provider ? "Sample" : "…"}</span>
          {now > 0 && <span className="text-muted">{fmtTime(serverNow, true)}</span>}
        </div>
      </header>

      {tab === "signal" && (
        <>
          {/* Pair chips */}
          <nav aria-label="Pair" className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {quick.map((s) => (
              <button
                key={s.symbol}
                onClick={() => setSettings({ ...settings, symbol: s.symbol })}
                aria-pressed={s.symbol === symbol}
                className={`shrink-0 rounded-full border px-3.5 py-2 text-sm font-semibold ${s.symbol === symbol ? "border-cyan/60 bg-cyan/15 text-ink" : "border-white/10 text-muted"}`}
              >
                {s.displaySymbol.replace(" (synthetic)", "")}
              </button>
            ))}
            {symbols.length > quick.length && (
              <select
                aria-label="More pairs"
                className="field shrink-0 rounded-full py-1 text-sm"
                value={quick.some((q) => q.symbol === symbol) ? "" : (symbol ?? "")}
                onChange={(e) => e.target.value && setSettings({ ...settings, symbol: e.target.value })}
              >
                <option value="">More…</option>
                {symbols.slice(quick.length).map((s) => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.displaySymbol}
                  </option>
                ))}
              </select>
            )}
          </nav>
          {symbolsError && <p role="alert" className="mt-2 text-sm text-put">{symbolsError}</p>}
          <p className="mt-2 text-xs text-faint" data-testid="otc-note">
            Sirf asli market (bina &quot;OTC&quot;) pairs ke liye. Quotex ke OTC pair par ye signal lagu nahi hote.
          </p>

          {!live && provider && (
            <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
              Live data band hai — yeh sirf sample (nakli) data hai, is se signal nahin aayega.
              {liveOffReason && <span className="mt-1 block text-xs" data-testid="live-off-reason">{liveOffReason}</span>}
            </p>
          )}

          {settings.mode === "FAST" && (
            <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn" data-testid="fast-demo">
              <b>⚡ Fast — EXPERIMENTAL:</b> har minute agli candle ka UP/DOWN deta hai (indicators ka vote). Yeh pakki prediction nahin; sirf demo account par test karein.
            </p>
          )}
          {settings.mode === "V4" && (
            <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn" data-testid="v4-demo">
              <b>v4 DEMO:</b> yeh strategy abhi saabit nahin. Sirf Quotex ke <b>demo account</b> par lagayein. 300 demo trades ke baad Results mein faisla dikhega.
            </p>
          )}
          {dailyStop && (
            <p role="status" className="mt-3 rounded-lg bg-put/10 px-3 py-2 text-sm text-put" data-testid="daily-stop">
              Aaj {settings.dailyLossLimit} LOSS ho chuke — haar ki had poori. Baqi din signal band rahenge.
              <button className="ml-2 underline" onClick={() => setSettings({ ...settings, ignoreDailyStopOn: localDayKey(now) })}>
                Aaj ke liye had hatayein
              </button>
            </p>
          )}

          {/* Big signal card */}
          <section
            aria-live="polite"
            aria-label="Signal"
            className="glass relative mt-4 overflow-hidden px-5 py-7 text-center"
            style={{ borderColor: theme.border, borderRadius: "1.75rem", boxShadow: `0 0 80px -20px ${theme.glow} inset` }}
          >
            <p className="text-sm text-muted">{symbolMeta?.displaySymbol.replace(" (synthetic)", "") ?? symbol ?? "—"}</p>
            <p className="verdict mt-2 text-[5.5rem] leading-none sm:text-[6.5rem]" style={{ color: theme.color }} data-testid="verdict">
              {theme.arrow && <span className="mr-2 align-middle text-[0.55em]">{theme.arrow}</span>}
              {verdict}
            </p>
            <p className="mt-3 text-base font-medium">{subline}</p>
            {reason && <p className="mt-1 text-sm text-muted">{reason}</p>}

            {showSignal && early && (
              <p className="mx-auto mt-4 w-fit rounded-full px-4 py-1.5 text-sm font-semibold" style={{ background: theme.glow, color: theme.color }} data-testid="starts-in">
                Signal wali candle shuru hone mein {startsIn}s baqi
              </p>
            )}
            {showSignal && !early && windowLeft !== null && (
              <p className="mx-auto mt-4 w-fit rounded-full px-4 py-1.5 text-sm font-semibold" style={{ background: theme.glow, color: theme.color }}>
                Abhi entry lein — {windowLeft}s baqi
              </p>
            )}
            {!showSignal && nextIn !== null && provider && (
              <p className="mt-4 text-sm text-muted">{scanning ? "Check ho raha hai…" : `Agla check ${nextIn}s mein`}</p>
            )}

            {chips.length > 0 && (
              <ul className="mt-4 flex flex-wrap justify-center gap-1.5" aria-label="Signal ki wajah">
                {chips.map((c) => (
                  <li key={c} className="rounded-full bg-white/5 px-2.5 py-1 text-xs">
                    ✓ {c}
                  </li>
                ))}
              </ul>
            )}

            {agree && (
              <div className="mx-auto mt-5 max-w-xs">
                <div className="flex justify-between text-xs text-muted">
                  <span>Indicators {agree.dir === "BULLISH" ? "UP" : "DOWN"} ke haq mein</span>
                  <span>
                    {agree.agree}/{agree.total}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-white/5">
                  <div className="h-1.5 rounded-full" style={{ width: `${(agree.agree / Math.max(1, agree.total)) * 100}%`, background: agree.dir === "BULLISH" ? "#3FDCA0" : "#FF7088" }} />
                </div>
              </div>
            )}

            {result && (
              <p className="mt-5 text-xs text-faint">
                Price {fmtPrice(result.entryReference)} — candle {fmtTime(result.signalCandleTime)} — {MODE_LABEL[settings.mode]} ({result.ruleVersion})
              </p>
            )}
          </section>

          {error && (
            <p role="alert" className="mt-3 text-center text-sm text-put">
              {error}
            </p>
          )}

          {/* Check now */}
          <section aria-label="Abhi check karein" className="mt-4">
            <button className="btn btn-primary w-full text-base" disabled={!provider || !symbol || checkBusy || scanning} onClick={() => void checkNow()}>
              {checkBusy ? "Market dekh raha hai…" : "🎯 Abhi check karein"}
            </button>
            <p className="mt-2 text-center text-xs text-faint">
              {settings.mode === "FAST"
                ? "⚡ Fast: har minute ke 45ve second par agli candle ka UP/DOWN deta hai. Yeh trend ki taraf ka andaza hai, pakki prediction nahin."
                : "Sirf tab BUY/SELL deta hai jab poora setup mojood ho. Zabardasti direction ab nahin di jaati — asli data par wo ~49% sahi thi."}
            </p>
          </section>

          {stratHealth.status !== "INSUFFICIENT" && stratHealth.status !== "OK" && (
            <p role="status" className={`mt-3 rounded-lg px-3 py-2 text-sm ${stratHealth.status === "DEGRADED" ? "bg-put/10 text-put" : "bg-warn/10 text-warn"}`} data-testid="health">
              {stratHealth.detailUr}
              {stratHealth.status === "DEGRADED" && (
                <button className="ml-2 underline" onClick={() => setSettings({ ...settings, ignoreHealth: true })}>
                  Phir bhi dikhayein
                </button>
              )}
            </p>
          )}

          {/* Today */}
          <button onClick={() => setTab("results")} className="glass-quiet mt-4 flex items-center justify-between px-4 py-3 text-left">
            <span className="text-sm text-muted">Aaj ke results</span>
            <span className="text-sm font-semibold">
              <span className="text-call">{wins} WIN</span> <span className="text-faint">/</span> <span className="text-put">{losses} LOSS</span>
            </span>
          </button>

          {/* Controls */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="seg" role="group" aria-label="Signal mode">
              {SIGNAL_MODES.map((m) => (
                <button key={m} className="whitespace-nowrap text-sm" aria-pressed={settings.mode === m} onClick={() => setSettings({ ...settings, mode: m, ignoreHealth: false })}>
                  {m === "FAST" ? "⚡ Fast" : m === "V4" ? "v4 Demo" : m === "V2" ? "v2" : m === "STRICT" ? "v1 S" : "v1 N"}
                </button>
              ))}
            </div>
            <button
              className="btn btn-ghost shrink-0 whitespace-nowrap px-3 text-sm"
              aria-pressed={settings.sound}
              aria-label={settings.sound ? "Awaaz on" : "Awaaz off"}
              onClick={() => {
                if (!settings.sound) unlockAudio();
                setSettings({ ...settings, sound: !settings.sound });
              }}
            >
              {settings.sound ? "🔔 On" : "🔕 Off"}
            </button>
          </div>
          <p className="mt-2 text-xs text-faint">
            v4 Demo: 2026 ki search ka behtareen tareeqa (test par 55.8%, lekin pakka saabit nahin) — sirf demo par aazmayein. v2: 2018–2020 mein chalta tha, 2026 ke saaf data par 47.7% — haar raha hai. v1 S/N: purane rules, 48–49% — ghaata. Purane versions sirf muqabla karne ke liye hain.
          </p>

          {analysis?.chart && (
            <div className="mt-4">
              <button className="text-sm text-cyan" onClick={() => setShowChart((v) => !v)} aria-expanded={showChart}>
                {showChart ? "Chart chhupayein" : "Chart dekhein"}
              </button>
              {showChart && (
                <div className="glass mt-2 p-2">
                  <CandleChart chart={analysis.chart} label={`${result?.displaySymbol} 1-minute chart`} />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === "screen" && <ScreenTab sound={settings.sound} />}
      {tab === "results" && (
        <ResultsTab tracked={tracked} setTracked={setTracked} payout={settings.payoutPercent / 100} now={serverNow} live={live} mode={settings.mode} />
      )}
      {tab === "backtest" && <BacktestTab provider={provider?.id ?? null} symbol={symbol} mode={settings.mode} payout={settings.payoutPercent / 100} live={live} />}
      {tab === "more" && (
        <section className="mt-5 space-y-6">
          <div>
            <h2 className="font-semibold">Payout %</h2>
            <p className="text-sm text-muted">Quotex par jo payout dikh raha ho (jaise 85) wahi likhein. Results aur backtest isi se hisaab lagate hain.</p>
            <input
              className="field mt-2 w-28"
              type="number"
              min={1}
              max={200}
              value={settings.payoutPercent}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 1 && v <= 200) setSettings({ ...settings, payoutPercent: v });
              }}
            />
            <p className="mt-1 text-xs text-faint">Barabar rehne ke liye kam az kam {(100 / (1 + settings.payoutPercent / 100)).toFixed(1)}% jeet chahiye.</p>
          </div>
          <div>
            <h2 className="font-semibold">Rozana haar ki had</h2>
            <p className="text-sm text-muted">Itne LOSS ke baad us din signal band ho jayenge (0 = band nahin). Is se nuqsaan qabu mein rehta hai; jeet nahin barhti.</p>
            <input
              className="field mt-2 w-28"
              type="number"
              min={0}
              max={50}
              value={settings.dailyLossLimit}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 0 && v <= 50) setSettings({ ...settings, dailyLossLimit: v });
              }}
              aria-label="Rozana haar ki had"
            />
          </div>
          <FeedTiming />
          <div>
            <h2 className="font-semibold">Yeh kaise kaam karta hai</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              <li>Har minute candle band hote hi app khud market check karta hai.</li>
              <li>v2: jab ek bari, mazboot candle Bollinger band se bahar band ho aur RSI hadd par ho, to agli candle ke liye ulti taraf (wapsi) ka signal.</li>
              <li>Data purana, adhoora ya ghalat ho to hamesha WAIT.</li>
              <li>Entry candle shuru hote hi lein — der se entry par yeh edge khatam ho jata hai.</li>
              <li>Signal ke baad agli candle (open → close) ka nateeja app khud WIN/LOSS likhta hai. Quotex ka asli nateeja aapki entry ke waqt aur unki price par depend karta hai, is liye thora alag ho sakta hai.</li>
              <li>Agar haal ke nataij break-even se saaf neeche chale jayen to signals khud ruk jaate hain.</li>
            </ul>
          </div>
          <div>
            <Link href="/pro" className="text-cyan underline-offset-2 hover:underline">
              Pro view kholein (poori details, chart, checks)
            </Link>
          </div>
          <p className="text-xs leading-relaxed text-faint">
            Sirf analysis. Trade aap khud lagate hain. Koi signal 100% sahi nahin hota aur munafa ki koi zamanat nahin. Pehle demo account par aazmayein. Apna Quotex password kabhi yahan na dalein. OTC ka live data mojood nahin, is liye OTC ke signal nahin diye jaate.
          </p>
        </section>
      )}

      {/* Bottom tab bar */}
      <nav aria-label="Sections" className="fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-abyss/90 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto grid max-w-xl grid-cols-5">
          {(
            [
              ["signal", "Signal"],
              ["screen", "Screen"],
              ["results", "Results"],
              ["backtest", "Backtest"],
              ["more", "More"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined} className={`py-3.5 text-sm font-semibold ${tab === id ? "text-cyan" : "text-muted"}`}>
              {label}
            </button>
          ))}
        </div>
      </nav>
    </main>
  );
}

/** How quickly the live feed delivered each finished candle (counted on this device). */
function FeedTiming() {
  const [s, setS] = useState<FeedStats | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read browser storage after mount
    setS(feedStatsStore.load());
  }, []);
  if (!s) return null;
  const total = s.attempt1 + s.attempt2 + s.attempt3 + s.missed;
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "—");
  return (
    <div data-testid="feed-timing">
      <h2 className="font-semibold">Feed timing</h2>
      <p className="text-sm text-muted">
        {total === 0
          ? "Abhi live scans nahin hue."
          : `${total} minute: pehli koshish par ${pct(s.attempt1)}, doosri ${pct(s.attempt2)}, teesri ${pct(s.attempt3)}, nahin mila ${pct(s.missed)}.`}
      </p>
      <p className="mt-1 text-xs text-faint">Agar &quot;nahin mila&quot; zyada ho to feed der se candle bhej raha hai — us waqt app WAIT dikhata hai.</p>
    </div>
  );
}
