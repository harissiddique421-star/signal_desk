"use client";

import type { Direction, SignalResult } from "@/lib/types";

const DIR: Record<Direction, { label: string; cls: string }> = {
  BULLISH: { label: "Bullish", cls: "text-call bg-call/10" },
  BEARISH: { label: "Bearish", cls: "text-put bg-put/10" },
  NEUTRAL: { label: "Neutral", cls: "text-hold bg-white/5" },
};

export function AnalysisBreakdown({ result }: { result: SignalResult | null }) {
  if (!result) {
    return (
      <section className="glass p-5" aria-labelledby="breakdown-heading">
        <h2 id="breakdown-heading" className="text-lg font-semibold">Analysis breakdown</h2>
        <p className="mt-2 text-muted">Run an analysis to see each check and every piece of evidence behind the decision.</p>
      </section>
    );
  }
  const modules = Array.from(new Set(result.evidence.map((e) => e.module)));
  return (
    <section className="glass p-5" aria-labelledby="breakdown-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="breakdown-heading" className="text-lg font-semibold">Analysis breakdown</h2>
        <span className="text-sm text-muted">Rules {result.ruleVersion}</span>
      </div>
      <p className="mt-1 text-sm text-muted" lang="ur-Latn">
        Har shart (check) pass honi zaroori hai. Ek bhi fail ho to faisla NO TRADE hota hai.
      </p>

      <h3 className="mt-5 font-semibold">Checks</h3>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {result.checks.map((c) => (
          <li key={c.id} className="glass-quiet flex gap-2.5 px-3 py-2 text-sm">
            <span aria-hidden="true" className={c.passed ? "text-call" : "text-put"}>{c.passed ? "✓" : "✕"}</span>
            <span>
              <span className="font-medium">{c.label}</span>
              <span className="sr-only">{c.passed ? " passed" : " failed"}</span>
              <span className="block text-muted">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {result.evidence.length > 0 && (
        <>
          <h3 className="mt-6 font-semibold">Evidence</h3>
          <div className="mt-2 space-y-4">
            {modules.map((m) => (
              <div key={m}>
                <h4 className="text-sm text-muted">{m}</h4>
                <ul className="mt-1.5 space-y-1.5">
                  {result.evidence
                    .filter((e) => e.module === m)
                    .map((e) => (
                      <li key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
                        <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${DIR[e.direction].cls}`}>{DIR[e.direction].label}</span>
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{e.label}</span>
                          <span className="text-muted"> — {e.detail}</span>
                          {e.detailUr && <span className="block text-faint" lang="ur-Latn">{e.detailUr}</span>}
                        </span>
                        <span className="text-xs text-faint">w {e.weight}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}

      {result.warnings.length > 0 && (
        <>
          <h3 className="mt-6 font-semibold">Risk warnings</h3>
          <ul className="mt-2 space-y-1 text-sm text-warn">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
