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
  source: r.source,
});

const fromLocal = (r: LocalJournalEntry): Row => ({ ...r });

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
  const report = useMemo(() => summarize(tradable.map((r) => ({ time: Date.parse(r.createdAt), outcome: r.outcome })), payout), [tradable, payout]);

  async function setOutcome(id: string, outcome: Outcome) {
    if (useServer) {
      const r = await api(`/api/journal/${id}`, { method: "PATCH", json: { outcome, payoutPercent: payout * 100 } });
      if (!r.ok) return setError(r.error);
      void load();
    } else {
      onLocalChange(local.map((e) => (e.id === id ? { ...e, outcome } : e)));
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
          Demo account par trade lene ke baad yahan nateeja (WIN / LOSS / TIE) darj karein. Sirf CALL/PUT ka nateeja darj ho sakta hai.
        </p>
      </div>

      {error && <p role="alert" className="text-put">{error}</p>}
      {loading && <p className="text-muted">Loading journal…</p>}

      {tradable.length > 0 ? (
        <div className="space-y-3">
          <PerformanceStats report={report} title="Demo performance" />
          {report.equityCurve.length > 1 && <EquityLine curve={report.equityCurve} label="Cumulative demo result in stakes" />}
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
                    {r.decision === "NO_TRADE" ? (
                      <span className="text-faint">n/a</span>
                    ) : (
                      <select
                        className="field py-1"
                        aria-label={`Outcome for ${r.pair} at ${fmtDateTime(r.createdAt)}`}
                        value={r.outcome}
                        onChange={(e) => void setOutcome(r.id, e.target.value as Outcome)}
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
