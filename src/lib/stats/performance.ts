export type Outcome = "UNRESOLVED" | "WIN" | "LOSS" | "TIE";

export interface TradeRecord {
  time: number;
  outcome: Outcome;
}

export interface PerformanceReport {
  sampleSize: number;
  resolved: number;
  unresolved: number;
  wins: number;
  losses: number;
  ties: number;
  /** wins / (wins + losses); ties excluded. null when no decided trades. */
  winRate: number | null;
  /** 95% Wilson interval for winRate */
  winRateCi95: [number, number] | null;
  /** payout as a fraction, e.g. 0.85 means a winning 1-unit stake returns +0.85 */
  payout: number;
  /** Win rate needed to break even at this payout: 1 / (1 + payout) */
  breakEvenWinRate: number;
  /** Net result in stake units (win +payout, loss −1, tie 0) */
  netUnits: number;
  /** netUnits / decided trades */
  expectancyPerTrade: number | null;
  maxLosingStreak: number;
  maxWinningStreak: number;
  /** Largest peak-to-trough fall of the cumulative unit curve */
  maxDrawdownUnits: number;
  equityCurve: number[];
  /** Plain-language caveats that must be shown with the numbers */
  caveats: string[];
}

export function wilson(successes: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)];
}

/**
 * Summarise outcomes under an explicit payout assumption and a flat 1-unit stake.
 * Records are processed in time order.
 */
export function summarize(records: TradeRecord[], payout: number): PerformanceReport {
  if (!(payout > 0 && payout <= 5)) throw new Error("payout must be a fraction in (0, 5]");
  const sorted = [...records].sort((a, b) => a.time - b.time);
  let wins = 0, losses = 0, ties = 0, unresolved = 0;
  let equity = 0, peak = 0, maxDd = 0;
  let lStreak = 0, wStreak = 0, maxL = 0, maxW = 0;
  const curve: number[] = [];
  for (const r of sorted) {
    if (r.outcome === "UNRESOLVED") { unresolved++; continue; }
    if (r.outcome === "WIN") { wins++; equity += payout; wStreak++; lStreak = 0; }
    else if (r.outcome === "LOSS") { losses++; equity -= 1; lStreak++; wStreak = 0; }
    else { ties++; }
    maxL = Math.max(maxL, lStreak);
    maxW = Math.max(maxW, wStreak);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    curve.push(round(equity));
  }
  const decided = wins + losses;
  const winRate = decided ? wins / decided : null;
  const breakEven = 1 / (1 + payout);
  const caveats = [
    "Past results do not guarantee future results. Pichle nataij mustaqbil ki zamanat nahin.",
    `Assumes a flat 1-unit stake and a ${(payout * 100).toFixed(0)}% payout on every win; real broker payouts vary by pair and time.`,
  ];
  if (decided < 100) caveats.push(`Small sample (${decided} decided trades): the win rate is not statistically reliable.`);
  const ci = wilson(wins, decided);
  if (ci && ci[0] <= breakEven && ci[1] >= breakEven) caveats.push("The 95% interval includes the break-even win rate: no demonstrated edge.");
  return {
    sampleSize: sorted.length,
    resolved: decided + ties,
    unresolved,
    wins,
    losses,
    ties,
    winRate,
    winRateCi95: ci,
    payout,
    breakEvenWinRate: breakEven,
    netUnits: round(equity),
    expectancyPerTrade: decided ? round(equity / decided) : null,
    maxLosingStreak: maxL,
    maxWinningStreak: maxW,
    maxDrawdownUnits: round(maxDd),
    equityCurve: curve,
    caveats,
  };
}

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}
