"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { JournalListResponse, JournalRow, MeResponse } from "@/lib/api/contracts";
import { api } from "@/lib/client/api";
import { fmtDateTime, fmtPrice } from "@/lib/client/format";
import type { LocalJournalEntry } from "@/lib/client/local-store";
import { summarize, type Outcome } from "@/lib/stats/performance";
import { EquityLine, PerformanceStats } from "./Performance";

type Row = {
  id: string;
  createdAt: string;
  pair: string;
  marketType: string;
  analysisKind: string;
  decision: string;
  entryReference: number | null;
  outcome: Outcome;
  entryDelaySeconds: number | null;
  resultSource: "UNVERIFIED" | "BROKER_MANUAL" | "FEED_ESTIMATE";
  source: string;
};

const fromServer = (r: JournalRow): Row => ({
  id: r.id,
  createdAt: r.created_at,
  pair: r.pair,
  marketType: r.market_type,
  analysisKind: r.analysis_kind,
  decision: r.decision,
  entryReference: r.entry_reference,
  outcome: r.outcome,
  entryDelaySeconds: r.entry_delay_seconds ?? null,
  resultSource: r.result_source ?? "UNVERIFIED",
  source: r.source,
});

const fromLocal = (r: LocalJournalEntry): Row => ({ ...r, entryDelaySeconds: r.entryDelaySeconds ?? null, resultSource: r.resultSource ?? "UNVERIFIED" });

export function JournalPanel(props: {
  me: MeResponse | null;
  payout: number;
  local: LocalJournalEntry[];
  onLocalChange: (next: LocalJournalEntry[]) => void;
  refreshKey: number;
}) {
  const { me, payout, local, onLocalChange, refreshKey } = props;
  const useServer = !!me?.accountsEnabled && !!me.user;
  const [server, setServer] = useState<JournalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!useServer) return;
    setLoading(true);
    const r = await api<JournalListResponse>(`/api/journal?payout=${payout}`);
    setLoading(false);
    if (r.ok) {
      setServer(r.data.records);
      setError(null);
    } else setError(r.error);
  }, [useServer, payout]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading remote data on mount/refresh
    void load();
  }, [load, refreshKey]);

  const rows: Row[] = useMemo(() => (useServer ? (server ?? []).map(fromServer) : local.map(fromLocal)), [useServer, server, local]);
  const tradable = rows.filter((r) => r.decision !== "NO_TRADE");
  const measured = tradable.filter((r) => r.resultSource === "BROKER_MANUAL");
  const report = useMemo(() => summarize(measured.map((r) => ({ time: Date.parse(r.createdAt), outcome: r.outcome })), payout), [measured, payout]);

  async function setOutcome(row: Row, outcome: Outcome) {
    if (useServer) {
      const r = await api(`/api/journal/${row.id}`, { method: "PATCH", json: { outcome, payoutPercent: payout * 100, entryDelaySeconds: row.entryDelaySeconds, resultSource: row.resultSource } });
      if (!r.ok) return setError(r.error);
      void load();
    } else {
      onLocalChange(local.map((e) => (e.id === row.id ? { ...e, outcome } : e)));
    }
  }

  async function setExecutionDetails(row: Row, patch: { entryDelaySeconds?: number | null; resultSource?: Row["resultSource"] }) {
    const nextDelay = patch.entryDelaySeconds === undefined ? row.entryDelaySeconds : patch.entryDelaySeconds;
    const nextSource = patch.resultSource ?? row.resultSource;
    if (useServer) {
      const r = await api(`/api/journal/${row.id}`, { method: "PATCH", json: { outcome: row.outcome, payoutPercent: payout * 100, entryDelaySeconds: nextDelay, resultSource: nextSource } });
      if (!r.ok) return setError(r.error);
      void load();
    } else {
      onLocalChange(local.map((e) => e.id === row.id ? { ...e, entryDelaySeconds: nextDelay, resultSource: nextSource } : e));
    }
  }

  function removeLocal(id: string) {
    onLocalChange(local.filter((e) => e.id !== id));
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          {useServer
            ? `Saved to your account (${me?.user?.email ?? "signed in"}). Demo trades only.`
            : me?.accountsEnabled
              ? "You are signed out, so entries are saved on this device only. Sign in under Settings to keep them in your account."
              : "Accounts are not configured on this deployment, so entries are saved on this device only."}
        </p>
        <p className="mt-1 text-sm text-faint" lang="ur-Latn">
          Demo result aur entry delay record karein. Broker ke demo interface se verify hua nateeja hi BROKER MANUAL mark karein; feed ka estimate alag rakhein.
        </p>
      </div>

      {error && <p role="alert" className="text-put">{error}</p>}
      {loading && <p className="text-muted">Loading journal…</p>}

      {tradable.length > 0 ? (
        <div className="space-y-3">
          <PerformanceStats report={report} title="Broker-confirmed demo performance" />
          <p className="text-xs text-muted">Sirf BROKER MANUAL records is report mein count hote hain. Feed estimates is accuracy se alag hain. Broker-confirmed resolved entries: {measured.filter((r) => r.outcome !== "UNRESOLVED" && r.outcome !== "TIE").length}.</p>
          {report.equityCurve.length > 1 && <EquityLine curve={report.equityCurve} label="Broker-confirmed cumulative demo result in stakes" />}
        </div>
      ) : (
        <p className="glass-quiet p-4 text-muted">
          No CALL or PUT signals recorded yet. Performance appears here once you save signals and record their outcomes — nothing is shown until real entries exist.
        </p>
      )}

      {rows.length > 0 && (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Journal entries</caption>
            <thead className="text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Time</th>
                <th className="py-2 pr-3 font-medium">Pair</th>
                <th className="py-2 pr-3 font-medium">Data</th>
                <th className="py-2 pr-3 font-medium">Decision</th>
                <th className="py-2 pr-3 font-medium">Entry ref.</th>
                <th className="py-2 pr-3 font-medium">Entry delay (s)</th>
                <th className="py-2 pr-3 font-medium">Result source</th>
                <th className="py-2 pr-3 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-white/5">
                  <td className="py-2 pr-3">{fmtDateTime(r.createdAt)}</td>
                  <td className="py-2 pr-3">
                    {r.pair} <span className="text-faint">{r.marketType === "OTC" ? "OTC" : ""}</span>
                  </td>
                  <td className="py-2 pr-3 text-muted">{r.analysisKind === "LIVE_FEED" ? "Live feed" : r.analysisKind === "SAMPLE" ? "Sample" : "Screenshot"}</td>
                  <td className={`py-2 pr-3 font-semibold ${r.decision === "CALL" ? "text-call" : r.decision === "PUT" ? "text-put" : "text-hold"}`}>{r.decision.replace("_", " ")}</td>
                  <td className="py-2 pr-3">{fmtPrice(r.entryReference)}</td>
                  <td className="py-2 pr-3">
                    {r.decision === "NO_TRADE" ? <span className="text-faint">n/a</span> : <input className="field w-20 py-1" type="number" min={0} max={3600} step={1} aria-label={`Entry delay seconds for ${r.pair}`} defaultValue={r.entryDelaySeconds ?? ""} placeholder="seconds" onBlur={(e) => { const raw = e.currentTarget.value.trim(); const n = raw === "" ? null : Number(raw); if (n === null || (Number.isInteger(n) && n >= 0 && n <= 3600)) void setExecutionDetails(r, { entryDelaySeconds: n }); }} />}
                  </td>
                  <td className="py-2 pr-3">
                    {r.decision === "NO_TRADE" ? <span className="text-faint">n/a</span> : <select className="field py-1" aria-label={`Result source for ${r.pair}`} value={r.resultSource} onChange={(e) => void setExecutionDetails(r, { resultSource: e.target.value as Row["resultSource"] })}>
                      <option value="UNVERIFIED">Unverified</option>
                      <option value="BROKER_MANUAL">Broker manual</option>
                      <option value="FEED_ESTIMATE">Feed estimate</option>
                    </select>}
                  </td>
                  <td className="py-2 pr-3">
                    {r.decision === "NO_TRADE" ? (
                      <span className="text-faint">n/a</span>
                    ) : (
                      <select
                        className="field py-1"
                        aria-label={`Outcome for ${r.pair} at ${fmtDateTime(r.createdAt)}`}
                        value={r.outcome}
                        onChange={(e) => void setOutcome(r, e.target.value as Outcome)}
                      >
                        <option value="UNRESOLVED">Unresolved</option>
                        <option value="WIN">Win</option>
                        <option value="LOSS">Loss</option>
                        <option value="TIE">Tie</option>
                      </select>
                    )}
                    {!useServer && (
                      <button className="ml-2 text-xs text-faint underline hover:text-muted" onClick={() => removeLocal(r.id)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
