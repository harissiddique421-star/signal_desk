import { wilson, type Outcome } from "./performance";

export type HealthStatus = "INSUFFICIENT" | "OK" | "WATCH" | "DEGRADED";

export interface StrategyHealth {
  status: HealthStatus;
  /** Decided (win/loss) trades in the recent window */
  n: number;
  wins: number;
  winRate: number | null;
  ci95: [number, number] | null;
  breakEven: number;
  detail: string;
  detailUr: string;
}

/**
 * Live degradation check for one strategy version, from its most recent resolved
 * signals (oldest → newest). Ties and unresolved signals are ignored.
 *
 * DEGRADED is only declared when the evidence is statistically meaningful: the
 * upper end of the 95 % Wilson interval of the recent win rate is below the
 * break-even win rate. A bad streak that is still consistent with break-even is
 * WATCH, not DEGRADED. The app pauses signals while DEGRADED.
 */
export function assessStrategyHealth(outcomes: Outcome[], payout: number, opts: { window?: number; minTrades?: number } = {}): StrategyHealth {
  const window = opts.window ?? 50;
  const minTrades = opts.minTrades ?? 20;
  const breakEven = 1 / (1 + payout);
  const decided = outcomes.filter((o) => o === "WIN" || o === "LOSS").slice(-window);
  const n = decided.length;
  const wins = decided.filter((o) => o === "WIN").length;
  const winRate = n ? wins / n : null;
  const ci95 = wilson(wins, n);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (n < minTrades) {
    return { status: "INSUFFICIENT", n, wins, winRate, ci95, breakEven, detail: `Only ${n} decided signals (need ${minTrades}) — too few to judge`, detailUr: `Abhi sirf ${n} nataij — faisla karne ke liye kam az kam ${minTrades} chahiye.` };
  }
  if (ci95 && ci95[1] < breakEven) {
    return {
      status: "DEGRADED",
      n,
      wins,
      winRate,
      ci95,
      breakEven,
      detail: `Last ${n}: ${pct(winRate!)} (95% CI up to ${pct(ci95[1])}) is below break-even ${pct(breakEven)} — signals paused`,
      detailUr: `Pichle ${n} signals mein jeet ${pct(winRate!)} — break-even ${pct(breakEven)} se saaf neeche. Signals rok diye gaye hain.`,
    };
  }
  if (winRate! < breakEven) {
    return { status: "WATCH", n, wins, winRate, ci95, breakEven, detail: `Last ${n}: ${pct(winRate!)}, below break-even ${pct(breakEven)} but not yet conclusive`, detailUr: `Pichle ${n} mein jeet ${pct(winRate!)} — break-even se kam, lekin abhi pakka nahin. Ehtiyat karein.` };
  }
  return { status: "OK", n, wins, winRate, ci95, breakEven, detail: `Last ${n}: ${pct(winRate!)} (break-even ${pct(breakEven)})`, detailUr: `Pichle ${n} mein jeet ${pct(winRate!)} (break-even ${pct(breakEven)}).` };
}
