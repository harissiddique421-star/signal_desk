"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzeResponse, HealthResponse, MeResponse, SymbolsResponse } from "@/lib/api/contracts";
import { api } from "@/lib/client/api";
import { fmtTime, tzName } from "@/lib/client/format";
import { DEFAULT_SETTINGS, localJournal, localSettings, type LocalJournalEntry, type LocalSettings } from "@/lib/client/local-store";
import { playSignalTone, unlockAudio } from "@/lib/client/sound";
import type { MarketType, ProviderSymbol, SignalResult } from "@/lib/types";
import { AnalysisBreakdown } from "./AnalysisBreakdown";
import { BacktestPanel } from "./BacktestPanel";
import { CandleChart } from "./CandleChart";
import { JournalPanel } from "./JournalPanel";
import { ScreenshotPanel } from "./ScreenshotPanel";
import { SettingsPanel } from "./SettingsPanel";
import { SignalCard } from "./SignalCard";
import { SourcesPanel } from "./SourcesPanel";

const TABS = [
  { id: "history", label: "Signal history" },
  { id: "journal", label: "Demo journal" },
  { id: "backtest", label: "Backtest" },
  { id: "screenshot", label: "Screenshot" },
  { id: "sources", label: "Sources" },
  { id: "settings", label: "Settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

interface HistoryItem {
  key: string;
  result: SignalResult;
}

export function Dashboard() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(0); // set on mount; 0 = clock not started yet
  const [online, setOnline] = useState(true);

  const [providerId, setProviderId] = useState<string | null>(null);
  const [marketType, setMarketType] = useState<MarketType>("LIVE");
  const [symbols, setSymbols] = useState<ProviderSymbol[]>([]);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);
  const [journal, setJournal] = useState<LocalJournalEntry[]>([]);
  const [journalRefresh, setJournalRefresh] = useState(0);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("history");
  const loadedLocal = useRef(false);

  // ---- bootstrap -------------------------------------------------------------
  const loadHealth = useCallback(async () => {
    const t0 = Date.now();
    const r = await api<HealthResponse>("/api/health");
    if (r.ok) {
      setHealth(r.data);
      setHealthError(null);
      setClockOffset(r.data.serverTime - (t0 + Date.now()) / 2);
    } else setHealthError(r.error);
  }, []);

  const loadMe = useCallback(async () => {
    const r = await api<MeResponse>("/api/auth/me");
    if (r.ok) setMe(r.data);
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time hydration from browser storage and server */
    setSettings(localSettings.load());
    setJournal(localJournal.load());
    loadedLocal.current = true;
    setOnline(navigator.onLine);
    setNow(Date.now());
    /* eslint-enable react-hooks/set-state-in-effect */
    void loadHealth();
    void loadMe();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const tick = setInterval(() => setNow(Date.now()), 500);
    const healthTimer = setInterval(() => void loadHealth(), 60_000);
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      clearInterval(tick);
      clearInterval(healthTimer);
    };
  }, [loadHealth, loadMe]);

  useEffect(() => {
    if (loadedLocal.current) localSettings.save(settings);
  }, [settings]);
  useEffect(() => {
    if (loadedLocal.current) localJournal.save(journal);
  }, [journal]);

  // Pick a default provider: a configured verified feed first, otherwise sample data.
  const usableProviders = useMemo(() => (health?.providers ?? []).filter((p) => p.status !== "NOT_CONFIGURED"), [health]);
  useEffect(() => {
    if (providerId || !usableProviders.length) return;
    const pick = usableProviders.find((p) => p.verified) ?? usableProviders[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default selection once providers are known
    setProviderId(pick.id);
  }, [usableProviders, providerId]);

  const provider = usableProviders.find((p) => p.id === providerId) ?? null;

  // Load symbols whenever provider / market type changes.
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    (async () => {
      const r = await api<SymbolsResponse>(`/api/symbols?provider=${encodeURIComponent(providerId)}&marketType=${marketType}`);
      if (cancelled) return;
      if (r.ok) {
        setSymbols(r.data.symbols);
        setSymbolsError(null);
        setSymbol((s) => (r.data.symbols.some((x) => x.symbol === s) ? s : (r.data.symbols[0]?.symbol ?? null)));
      } else {
        setSymbols([]);
        setSymbol(null);
        setSymbolsError(r.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerId, marketType]);

  // ---- analysis ----------------------------------------------------------------
  const runAnalysis = useCallback(async () => {
    if (!providerId || !symbol) return;
    setAnalyzing(true);
    const r = await api<AnalyzeResponse>("/api/analyze", { method: "POST", json: { provider: providerId, symbol, marketType } });
    setAnalyzing(false);
    if (!r.ok) {
      setAnalyzeError(r.error);
      setAnalysis(null);
      return;
    }
    setAnalyzeError(null);
    setAnalysis(r.data);
    const res = r.data.result;
    setHistory((h) => [{ key: `${res.analyzedAt}-${res.symbol}`, result: res }, ...h].slice(0, 200));
    if (settings.sound && res.decision !== "NO_TRADE") playSignalTone(res.decision);
  }, [providerId, symbol, marketType, settings.sound]);

  // Auto-refresh: run 3 s after each server-time minute boundary.
  useEffect(() => {
    if (!settings.autoRefresh || !symbol || !online) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const serverNow = Date.now() + clockOffset;
      const delay = 60_000 - (serverNow % 60_000) + 3000;
      timer = setTimeout(() => {
        void runAnalysis();
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [settings.autoRefresh, symbol, online, clockOffset, runAnalysis]);

  // ---- journal -----------------------------------------------------------------
  async function saveToJournal(res: SignalResult) {
    setSaveMsg(null);
    const payload = {
      source: res.source,
      pair: res.symbol,
      marketType: res.marketType,
      analysisKind: res.analysisKind,
      decision: res.decision,
      engineDecision: res.engineDecision,
      signalCandleTime: res.signalCandleTime ? new Date(res.signalCandleTime).toISOString() : null,
      entryReference: res.entryReference,
      expirySeconds: 60 as const,
      agreementScore: res.agreementScore,
      ruleVersion: res.ruleVersion,
      evidence: res.evidence.map((e) => ({ id: e.id, direction: e.direction, weight: e.weight, detail: e.detail.slice(0, 300) })),
      reasons: res.reasons.map((r) => r.slice(0, 300)),
    };
    if (me?.accountsEnabled && me.user) {
      const r = await api<{ id: string }>("/api/journal", { method: "POST", json: payload });
      setSaveMsg(r.ok ? "Saved to your account journal." : r.error);
      if (r.ok) setJournalRefresh((k) => k + 1);
      return;
    }
    const entry: LocalJournalEntry = {
      id: crypto.randomUUID(),
      createdAt: new Date(res.analyzedAt).toISOString(),
      source: res.source,
      pair: res.symbol,
      marketType: res.marketType,
      analysisKind: res.analysisKind,
      decision: res.decision,
      engineDecision: res.engineDecision,
      signalCandleTime: payload.signalCandleTime,
      entryReference: res.entryReference,
      agreementScore: res.agreementScore,
      ruleVersion: res.ruleVersion,
      outcome: "UNRESOLVED",
    };
    setJournal((j) => [entry, ...j]);
    setSaveMsg("Saved on this device.");
  }

  // ---- derived -----------------------------------------------------------------
  const serverNow = now + clockOffset;
  const result = analysis?.result ?? null;
  const tradableCount = history.filter((h) => h.result.decision !== "NO_TRADE").length;
  const resolvedLocal = journal.filter((j) => j.decision !== "NO_TRADE" && j.outcome !== "UNRESOLVED").length;
  const liveAvailable = !!health?.liveDataAvailable;
  const usingSample = provider && !provider.verified;

  return (
    <main className="mx-auto max-w-7xl px-4 pt-5 pb-16 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
            <rect x="3" y="15" width="6" height="10" rx="1.5" fill="#4C8DFF" />
            <rect x="12" y="9" width="6" height="12" rx="1.5" fill="#56D4EC" />
            <rect x="21" y="4" width="6" height="11" rx="1.5" fill="#56D4EC" />
          </svg>
          <div>
            <h1 className="text-xl leading-none font-semibold tracking-tight" style={{ fontStretch: "85%" }}>
              Signal Desk
            </h1>
            <p className="text-xs text-muted">1-minute analysis, 1-minute expiry. You decide every trade.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm" role="status">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${!online ? "bg-put" : liveAvailable ? "bg-call" : "bg-warn"}`} aria-hidden="true" />
          <span>{!online ? "Offline" : !health ? "Checking data sources…" : liveAvailable ? "Live data connected" : "Live data unavailable"}</span>
          <span className="hidden text-muted sm:inline">{fmtTime(serverNow, true)} {tzName()}</span>
        </div>
      </header>

      {/* Critical banners */}
      <div className="mt-4 space-y-2">
        {!online && (
          <p role="alert" className="glass border-put/40 px-4 py-3 text-sm">
            You are offline. Nothing on screen is updating, and no new signals can be produced until the connection returns.
          </p>
        )}
        {health && !liveAvailable && (
          <div role="alert" className="glass px-4 py-3 text-sm" style={{ borderColor: "rgba(245,196,91,0.4)" }}>
            <p className="font-semibold text-warn">Live data unavailable — no live signals will be generated.</p>
            <p className="mt-1 text-muted">
              No verified market-data provider is configured. {usableProviders.some((p) => !p.verified) ? "You can explore the dashboard with clearly labelled synthetic sample data, which never produces a tradable signal." : ""}
            </p>
            <p className="mt-1 text-faint" lang="ur-Latn">Live data mojood nahin, is liye koi live signal nahin banega.</p>
          </div>
        )}
        {healthError && (
          <p role="alert" className="glass px-4 py-3 text-sm text-put">
            Could not reach the server: {healthError}
          </p>
        )}
      </div>

      {/* Overview strip */}
      <section aria-label="Overview" className="glass mt-4 grid grid-cols-2 divide-white/10 sm:grid-cols-4 sm:divide-x">
        {[
          ["Data source", provider ? provider.name : health ? "None configured" : "…", provider ? (provider.verified ? "Verified feed" : "Synthetic, not tradable") : ""],
          ["Analyses this session", String(history.length), `${tradableCount} tradable signals`],
          ["OTC data", health ? (health.otcDataAvailable ? "Available" : "Not available") : "…", "No permitted OTC feed exists"],
          ["Journal outcomes", String(me?.user ? "In account" : resolvedLocal), me?.user ? "See Demo journal" : "resolved on this device"],
        ].map(([k, v, sub]) => (
          <div key={k} className="px-4 py-3">
            <p className="text-xs text-muted">{k}</p>
            <p className="text-lg font-semibold">{v}</p>
            <p className="text-xs text-faint">{sub}</p>
          </div>
        ))}
      </section>

      {/* Controls */}
      <section aria-label="Market selection" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-muted">Data source</span>
          <select className="field min-w-48" value={providerId ?? ""} onChange={(e) => setProviderId(e.target.value || null)} disabled={!usableProviders.length}>
            {!usableProviders.length && <option value="">None available</option>}
            {usableProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-1 text-sm">
          <span className="text-muted" id="mt-label">Market</span>
          <div className="seg" role="group" aria-labelledby="mt-label">
            {(["LIVE", "OTC"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={marketType === m} onClick={() => setMarketType(m)}>
                {m === "LIVE" ? "Regular" : "OTC"}
              </button>
            ))}
          </div>
        </div>
        <label className="grid gap-1 text-sm">
          <span className="text-muted">Pair</span>
          <select className="field min-w-44" value={symbol ?? ""} onChange={(e) => setSymbol(e.target.value || null)} disabled={!symbols.length}>
            {!symbols.length && <option value="">{symbolsError ? "Unavailable" : marketType === "OTC" ? "No OTC pairs from this source" : "No pairs"}</option>}
            {symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.displaySymbol}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" onClick={() => void runAnalysis()} disabled={!symbol || analyzing || !online}>
          {analyzing ? "Analysing…" : "Analyse now"}
        </button>
        <div className="flex flex-wrap gap-4 pb-2.5 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4 accent-cyan-400" checked={settings.autoRefresh} onChange={(e) => setSettings({ ...settings, autoRefresh: e.target.checked })} />
            Re-analyse each minute
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-cyan-400"
              checked={settings.sound}
              onChange={(e) => {
                if (e.target.checked) unlockAudio();
                setSettings({ ...settings, sound: e.target.checked });
              }}
            />
            Sound on CALL/PUT
          </label>
        </div>
      </section>
      {symbolsError && <p role="alert" className="mt-2 text-sm text-put">{symbolsError}</p>}
      {marketType === "OTC" && (
        <p className="mt-2 text-sm text-warn">
          OTC quotes are generated by the broker and are not published by any permitted data provider. Regular-market feeds are never used as a stand-in, so OTC live analysis always returns NO TRADE.
        </p>
      )}

      {/* Workspace */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="order-2 space-y-5 lg:order-1">
          <section className="glass p-4" aria-labelledby="chart-h">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
              <h2 id="chart-h" className="font-semibold">
                {analysis?.result.displaySymbol ?? "Chart"} <span className="font-normal text-muted">1-minute, closed candles</span>
              </h2>
              {analysis && (
                <span className="text-xs text-muted">
                  {analysis.provider.name}, fetched {fmtTime(analysis.result.analyzedAt, true)}
                  {analysis.provider.latencyMs ? `, ${analysis.provider.latencyMs} ms` : ""}
                </span>
              )}
            </div>
            {usingSample && analysis && (
              <p className="mx-1 mt-2 rounded-md bg-warn/10 px-3 py-1.5 text-xs text-warn">Synthetic sample candles — not real market prices.</p>
            )}
            <div className="mt-3">
              {analyzing && !analysis ? (
                <div className="grid h-64 place-items-center text-muted">Loading candles…</div>
              ) : analyzeError ? (
                <div className="grid h-64 place-items-center px-6 text-center">
                  <div>
                    <p role="alert" className="text-put">{analyzeError}</p>
                    <p className="mt-1 text-sm text-muted">The signal stays at NO TRADE. Check Sources for provider status.</p>
                  </div>
                </div>
              ) : analysis?.chart ? (
                <>
                  <CandleChart chart={analysis.chart} label={`Candlestick chart of ${analysis.result.displaySymbol}, last ${analysis.chart.candles.length} closed one-minute candles`} />
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted" aria-label="Chart legend">
                    <li><span className="text-cyan">━</span> EMA fast</li>
                    <li><span className="text-blue">━</span> EMA slow</li>
                    <li><span className="text-blue">┅</span> Bollinger Bands</li>
                    <li><span className="text-call">▭</span> Support zone</li>
                    <li><span className="text-put">▭</span> Resistance zone</li>
                  </ul>
                </>
              ) : (
                <div className="grid h-64 place-items-center px-6 text-center text-muted">
                  {analysis ? "No chart: the source returned no usable candles for this selection." : symbol ? "Choose Analyse now to load the latest closed candles." : "Pick a data source and pair to begin."}
                </div>
              )}
            </div>
          </section>
          <AnalysisBreakdown result={result} />
        </div>

        <div className="order-1 space-y-3 lg:order-2">
          <div className="lg:sticky lg:top-4">
            <SignalCard result={result} now={serverNow} loading={analyzing} />
            {result && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button className="btn btn-ghost" onClick={() => void saveToJournal(result)}>
                  Save to demo journal
                </button>
                {saveMsg && <span className="text-sm text-muted" role="status">{saveMsg}</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <section className="mt-8">
        <div role="tablist" aria-label="Dashboard sections" className="flex gap-1 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button key={t.id} role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="glass mt-3 p-5">
          {tab === "history" && (
            <div>
              <p className="text-sm text-muted">Every analysis in this browser session, newest first. Save any of them to the demo journal.</p>
              {history.length === 0 ? (
                <p className="mt-4 text-muted">No analyses yet. Signals appear here as they are produced.</p>
              ) : (
                <div className="relative mt-3 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead className="text-muted">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Time</th>
                        <th className="py-2 pr-3 font-medium">Pair</th>
                        <th className="py-2 pr-3 font-medium">Decision</th>
                        <th className="py-2 pr-3 font-medium">Main reason</th>
                        <th className="py-2 pr-3 font-medium"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map(({ key, result: r }) => (
                        <tr key={key} className="border-t border-white/5">
                          <td className="py-2 pr-3">{fmtTime(r.analyzedAt, true)}</td>
                          <td className="py-2 pr-3">{r.displaySymbol}</td>
                          <td className={`py-2 pr-3 font-semibold ${r.decision === "CALL" ? "text-call" : r.decision === "PUT" ? "text-put" : "text-hold"}`}>{r.decision.replace("_", " ")}</td>
                          <td className="max-w-80 truncate py-2 pr-3 text-muted">{r.reasons[0] ?? "All checks passed"}</td>
                          <td className="py-2 pr-3">
                            <button className="text-cyan underline-offset-2 hover:underline" onClick={() => void saveToJournal(r)}>
                              Save
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {tab === "journal" && <JournalPanel me={me} payout={settings.payoutPercent / 100} local={journal} onLocalChange={setJournal} refreshKey={journalRefresh} />}
          {tab === "backtest" && <BacktestPanel provider={providerId} symbol={symbol} marketType={marketType} payout={settings.payoutPercent / 100} />}
          {tab === "screenshot" && <ScreenshotPanel />}
          {tab === "sources" && <SourcesPanel health={health} error={healthError} />}
          {tab === "settings" && <SettingsPanel settings={settings} onChange={setSettings} me={me} onAuthChange={() => void loadMe()} />}
        </div>
      </section>

      <footer className="mt-10 space-y-1 text-xs text-faint">
        <p>Signal Desk provides rule-based analysis and alerts only. It does not place trades, click anything for you, or connect to any broker account. Past results do not guarantee future results.</p>
        <p lang="ur-Latn">Yeh sirf tajziya hai — har trade ka faisla aap khud karte hain. Munafa ki koi zamanat nahin.</p>
      </footer>
    </main>
  );
}
