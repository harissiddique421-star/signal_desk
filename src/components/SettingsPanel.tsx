"use client";

import { useState } from "react";
import type { MeResponse } from "@/lib/api/contracts";
import { api } from "@/lib/client/api";
import type { LocalSettings } from "@/lib/client/local-store";
import { DEFAULT_RULES } from "@/lib/config/rules";

const RULE_NOTES: [keyof typeof DEFAULT_RULES, string][] = [
  ["minCandles", "Closed 1-minute candles required before analysing"],
  ["maxStalenessSeconds", "Max seconds since the last candle closed"],
  ["entryWindowSeconds", "Seconds after the candle close in which a signal stays actionable"],
  ["gapLookback", "Recent candles that must have no gaps"],
  ["minAgreement", "Minimum rule agreement score (0–1)"],
  ["minSupportingEvidence", "Minimum evidence items pointing the same way"],
  ["requireMtfAgreement", "5-minute trend must agree"],
  ["minAtrPercentile", "Below this ATR percentile the market is too quiet"],
  ["maxAtrPercentile", "Above this ATR percentile volatility is too high"],
  ["levelProximityAtr", "Opposing support/resistance closer than this (in ATR) blocks the trade"],
  ["requireNewsFilter", "Block all signals when no news calendar is configured"],
];

export function SettingsPanel({ settings, onChange, me, onAuthChange }: { settings: LocalSettings; onChange: (s: LocalSettings) => void; me: MeResponse | null; onAuthChange: () => void }) {
  const [email, setEmail] = useState("");
  const [authMsg, setAuthMsg] = useState<string | null>(null);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    const r = await api<{ message: string }>("/api/auth/login", { method: "POST", json: { email } });
    setAuthMsg(r.ok ? r.data.message : r.error);
  }
  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    onAuthChange();
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="pref-h">
        <h3 id="pref-h" className="font-semibold">Preferences</h3>
        <div className="mt-3 flex flex-wrap items-end gap-5">
          <label className="grid gap-1 text-sm">
            <span className="text-muted">Payout assumption (%)</span>
            <input
              className="field w-28"
              type="number"
              min={1}
              max={200}
              value={settings.payoutPercent}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 1 && v <= 200) onChange({ ...settings, payoutPercent: v });
              }}
            />
          </label>
          <p className="max-w-md pb-2 text-sm text-muted">
            Used for net results and the break-even win rate ({(100 / (1 + settings.payoutPercent / 100)).toFixed(1)}% at this payout). Use the payout your broker actually shows for the pair.
          </p>
        </div>
      </section>

      <section aria-labelledby="acct-h">
        <h3 id="acct-h" className="font-semibold">Account</h3>
        {!me?.accountsEnabled ? (
          <p className="mt-2 text-sm text-muted">Accounts are not configured on this deployment (Supabase environment variables are missing). History is kept on this device only.</p>
        ) : me.user ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <span>Signed in as {me.user.email}</span>
            <button className="btn btn-ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        ) : (
          <form className="mt-2 flex flex-wrap items-end gap-3" onSubmit={login}>
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Email for a sign-in link</span>
              <input className="field w-72" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button className="btn btn-primary" type="submit">
              Send sign-in link
            </button>
            {authMsg && <p className="w-full text-sm text-muted" role="status">{authMsg}</p>}
          </form>
        )}
        <p className="mt-2 text-xs text-faint">Never enter your Quotex login here. Signal Desk does not connect to your broker account.</p>
      </section>

      <section aria-labelledby="rules-h">
        <h3 id="rules-h" className="font-semibold">Signal rules ({DEFAULT_RULES.version})</h3>
        <p className="mt-1 text-sm text-faint" lang="ur-Latn">Yeh qawaid saaf aur muqarrar hain — koi chhupa hua AI model nahin.</p>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {RULE_NOTES.map(([k, note]) => (
            <div key={k} className="glass-quiet flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
              <dt className="text-muted">{note}</dt>
              <dd className="font-semibold">{String(DEFAULT_RULES[k])}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-faint">Defaults live in src/lib/config/rules.ts; the analyze API also accepts validated per-request overrides.</p>
      </section>
    </div>
  );
}
