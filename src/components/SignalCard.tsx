"use client";

import type { SignalResult } from "@/lib/types";
import { fmtPrice, fmtTime } from "@/lib/client/format";

const KIND_LABEL: Record<SignalResult["analysisKind"], string> = {
  LIVE_FEED: "Verified live feed",
  SAMPLE: "Sample data — not a signal",
  SCREENSHOT: "Screenshot-derived",
};

const STYLE = {
  CALL: { color: "text-call", ring: "#3FDCA0", border: "rgba(63,220,160,0.45)", word: "CALL", sub: "Price expected higher at expiry", ur: "Upar (CALL) ka ishara" },
  PUT: { color: "text-put", ring: "#FF7088", border: "rgba(255,112,136,0.45)", word: "PUT", sub: "Price expected lower at expiry", ur: "Neeche (PUT) ka ishara" },
  NO_TRADE: { color: "text-hold", ring: "#A9B7CA", border: "rgba(169,183,202,0.28)", word: "NO TRADE", sub: "Conditions not met — stay out", ur: "Koi trade nahin — sharait poori nahin" },
} as const;

function CandleClock({ now }: { now: number }) {
  if (!now) return <div className="h-16" aria-hidden="true" />;
  const into = (now % 60_000) / 60_000;
  const left = Math.ceil(60 - into * 60);
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-3">
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(150,195,255,0.12)" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="#56D4EC"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - into)}
          transform="rotate(-90 32 32)"
        />
        <text x="32" y="37" textAnchor="middle" fontSize="15" fontWeight="600" fill="#E7EEF8">
          {left}
        </text>
      </svg>
      <div className="text-sm leading-snug">
        <div className="text-ink">Current candle closes in {left}s</div>
        <div className="text-muted">Analysis uses closed candles only</div>
      </div>
    </div>
  );
}

export function SignalCard({ result, now, loading }: { result: SignalResult | null; now: number; loading: boolean }) {
  const d = result?.decision ?? "NO_TRADE";
  const s = STYLE[d];
  const windowLeft = result?.entryWindowEnd && now ? Math.ceil((result.entryWindowEnd - now) / 1000) : null;
  const expired = windowLeft !== null && windowLeft <= 0;
  const tradable = d !== "NO_TRADE";

  return (
    <section
      aria-labelledby="signal-heading"
      aria-live="polite"
      className="glass relative overflow-hidden p-5 sm:p-6"
      style={{ borderColor: s.border, borderRadius: "1.4rem" }}
    >
      <h2 id="signal-heading" className="sr-only">
        Signal
      </h2>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted">
            {result ? (
              <>
                <span className="text-ink">{result.displaySymbol}</span> in the {result.marketType === "OTC" ? "OTC market" : "regular market"}
              </>
            ) : (
              "No analysis yet"
            )}
          </p>
          <p className={`verdict mt-2 text-6xl sm:text-7xl ${s.color} ${tradable && expired ? "line-through opacity-50" : ""}`} data-testid="verdict">
            {loading && !result ? "…" : s.word}
          </p>
          <p className="mt-2 text-ink">{result ? s.sub : "Safe default: NO TRADE until a verified live analysis passes every check."}</p>
          <p className="text-sm text-muted" lang="ur-Latn">{result ? s.ur : "Jab tak tasdeeq shuda live data na ho, koi trade nahin."}</p>
        </div>
      </div>

      {result && (
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-muted">Data</dt>
            <dd className={result.analysisKind === "LIVE_FEED" ? "text-cyan" : "text-warn"}>{KIND_LABEL[result.analysisKind]}</dd>
          </div>
          <div>
            <dt className="text-muted">Source</dt>
            <dd>{result.source}</dd>
          </div>
          <div>
            <dt className="text-muted">Signal candle</dt>
            <dd>{result.signalCandleTime ? `${fmtTime(result.signalCandleTime)} close` : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">Entry reference</dt>
            <dd>{fmtPrice(result.entryReference)}</dd>
          </div>
          <div>
            <dt className="text-muted">Expiry</dt>
            <dd>1 minute from entry</dd>
          </div>
          <div>
            <dt className="text-muted">Entry window</dt>
            <dd className={tradable && !expired ? "text-cyan" : ""}>
              {tradable ? (expired ? "Expired — do not enter" : `${windowLeft}s left`) : result.entryWindowStart ? `Opens ${fmtTime(result.entryWindowStart, true)}` : "—"}
            </dd>
          </div>
        </dl>
      )}

      {result && (
        <div className="mt-5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted">Rule agreement</span>
            <span>{result.agreementScore > 0 ? "+" : ""}{result.agreementScore.toFixed(2)}</span>
          </div>
          <div className="relative mt-2 h-2 rounded-full bg-white/5" aria-hidden="true">
            <div className="absolute top-0 left-1/2 h-2 w-px bg-white/30" />
            <div
              className="absolute top-0 h-2 rounded-full"
              style={{
                left: result.agreementScore >= 0 ? "50%" : `${50 + result.agreementScore * 50}%`,
                width: `${Math.abs(result.agreementScore) * 50}%`,
                background: result.agreementScore >= 0 ? "#3FDCA0" : "#FF7088",
              }}
            />
          </div>
          <p className="mt-1.5 text-xs text-muted">Weighted bullish minus bearish evidence, −1 to +1. Not a probability of winning: on 3.87 M historical minutes it had no relationship to outcomes (docs/RESEARCH.md §9). v2 does not use it.</p>
        </div>
      )}

      {result && result.reasons.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Why no trade</h3>
          <ul className="mt-2 space-y-1.5 text-sm text-muted">
            {result.reasons.slice(0, 5).map((r) => (
              <li key={r} className="flex gap-2">
                <span aria-hidden="true" className="text-put">✕</span>
                <span>{r}</span>
              </li>
            ))}
            {result.reasons.length > 5 && <li className="text-faint">+{result.reasons.length - 5} more in the breakdown</li>}
          </ul>
        </div>
      )}

      <div className="mt-5 border-t border-white/10 pt-4">
        <CandleClock now={now} />
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted">
        Analysis only. You place every trade yourself. No accuracy or profit is guaranteed; binary options can lose the full stake.
      </p>
    </section>
  );
}
