import type { SignalMode } from "../config/presets";
import { SIGNAL_MODES } from "../config/presets";
import type { Outcome } from "../stats/performance";
import type { MarketType } from "../types";

/** A BUY/SELL signal the app produced, tracked until the feed settles it. */
export interface TrackedSignal {
  id: string; // `${pair}-${signalCandleTime}`
  pair: string;
  provider: string;
  marketType: MarketType;
  decision: "CALL" | "PUT";
  signalCandleTime: number;
  entryRef: number | null;
  mode: SignalMode;
  /** Rule version that produced the signal (e.g. rules-v2-fade) */
  ruleVersion?: string;
  /**
   * AUTO = passed every rule of the active mode; SHADOW = what a comparison version would
   * have done (never shown as a signal); MANUAL = forced by the old Generate button (no longer produced)
   */
  kind?: "AUTO" | "MANUAL" | "SHADOW";
  /** Share of weighted evidence pointing this way, 0-100 (not a win probability) */
  strength?: number;
  /** Generate-button strength bucket */
  label?: "Mazboot" | "Darmiyana" | "Kamzor";
  createdAt: number;
  status: "PENDING" | "RESOLVED" | "UNAVAILABLE";
  outcome?: Exclude<Outcome, "UNRESOLVED">;
  entry?: number;
  exit?: number;
}

const KEY = "signal-desk:tracked:v1";

export const trackedStore = {
  load(): TrackedSignal[] {
    try {
      const raw = window.localStorage.getItem(KEY);
      const v = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  },
  save(list: TrackedSignal[]) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, 2000)));
    } catch {
      /* storage unavailable */
    }
  },
};

export interface SimpleSettings {
  mode: SignalMode;
  /** User chose to keep seeing signals although the monitor marked the strategy DEGRADED */
  ignoreHealth?: boolean;
  sound: boolean;
  payoutPercent: number;
  symbol: string | null;
}

const SKEY = "signal-desk:simple-settings:v1";
/** Bumped when a default must override what users saved earlier. */
const SETTINGS_VERSION = 2;
export const DEFAULT_SIMPLE: SimpleSettings = { mode: "V2", sound: true, payoutPercent: 85, symbol: null };

/**
 * Merge saved settings with defaults. Settings saved before version 2 had NORMAL as
 * the default mode, which lost money on historical data, so they move to V2 once.
 * A mode chosen after the migration is kept.
 */
export function migrateSettings(saved: unknown): SimpleSettings {
  const s = saved && typeof saved === "object" ? (saved as Partial<SimpleSettings> & { settingsVersion?: number }) : {};
  const merged = { ...DEFAULT_SIMPLE, ...s };
  if ((s.settingsVersion ?? 1) < SETTINGS_VERSION || !SIGNAL_MODES.includes(merged.mode)) merged.mode = DEFAULT_SIMPLE.mode;
  const { mode, sound, payoutPercent, symbol, ignoreHealth } = merged;
  return { mode, sound: !!sound, payoutPercent: Number(payoutPercent) || DEFAULT_SIMPLE.payoutPercent, symbol: typeof symbol === "string" ? symbol : null, ignoreHealth: !!ignoreHealth };
}

export const simpleSettingsStore = {
  load(): SimpleSettings {
    try {
      const raw = window.localStorage.getItem(SKEY);
      return migrateSettings(raw ? JSON.parse(raw) : { settingsVersion: SETTINGS_VERSION });
    } catch {
      return DEFAULT_SIMPLE;
    }
  },
  save(s: SimpleSettings) {
    try {
      window.localStorage.setItem(SKEY, JSON.stringify({ ...s, settingsVersion: SETTINGS_VERSION }));
    } catch {
      /* storage unavailable */
    }
  },
};

export function isToday(ms: number, now = Date.now()) {
  const a = new Date(ms);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Today's tally for the main screen. Counts only signals that passed every rule
 * (AUTO) under the current strategy mode: the old Generate button's forced
 * directions and other strategy versions are kept in Results, but mixing them into
 * one headline number hid how each version really performed.
 */
export function todaysTally(list: TrackedSignal[], now: number, mode: SignalMode): { wins: number; losses: number; ties: number } {
  const today = list.filter((t) => (t.kind ?? "AUTO") === "AUTO" && t.mode === mode && isToday(t.createdAt, now));
  return {
    wins: today.filter((t) => t.outcome === "WIN").length,
    losses: today.filter((t) => t.outcome === "LOSS").length,
    ties: today.filter((t) => t.outcome === "TIE").length,
  };
}

/** Resolved AUTO outcomes for one mode, oldest first — input to the degradation monitor. */
export function autoOutcomes(list: TrackedSignal[], mode: SignalMode): Outcome[] {
  return list
    .filter((t) => (t.kind ?? "AUTO") === "AUTO" && t.mode === mode && t.status === "RESOLVED" && t.outcome)
    .sort((a, b) => a.signalCandleTime - b.signalCandleTime)
    .map((t) => t.outcome as Outcome);
}

/** Live-minute opportunities each version was evaluated on (data gates passed), for coverage. */
export type OpportunityCounts = Record<string, number>;
const OKEY = "signal-desk:opportunities:v1";
export const opportunityStore = {
  load(): OpportunityCounts {
    try {
      const v = JSON.parse(window.localStorage.getItem(OKEY) ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  },
  save(c: OpportunityCounts) {
    try {
      window.localStorage.setItem(OKEY, JSON.stringify(c));
    } catch {
      /* storage unavailable */
    }
  },
};

export interface VersionRow {
  version: string;
  label: string;
  opportunities: number;
  signals: number;
  wins: number;
  losses: number;
  ties: number;
  pending: number;
  /** signals / opportunities */
  coverage: number | null;
}

/**
 * Live side-by-side comparison of v2 (rules) and v3 (ML shadow) on the same minutes.
 * A version's signals are its AUTO records when it was the active mode plus its SHADOW records otherwise.
 */
export function versionComparison(list: TrackedSignal[], opps: OpportunityCounts): VersionRow[] {
  const rows: [string, string, (t: TrackedSignal) => boolean][] = [
    ["rules-v2-fade", "v2 Fade (rules)", (t) => t.ruleVersion === "rules-v2-fade" || ((t.kind ?? "AUTO") === "AUTO" && t.mode === "V2" && !t.ruleVersion)],
    ["v3-ml-shadow", "v3 ML (shadow)", (t) => t.ruleVersion === "v3-ml-shadow"],
  ];
  return rows.map(([version, label, match]) => {
    const items = list.filter((t) => t.kind !== "MANUAL" && match(t));
    const o = opps[version] ?? 0;
    return {
      version,
      label,
      opportunities: o,
      signals: items.length,
      wins: items.filter((t) => t.outcome === "WIN").length,
      losses: items.filter((t) => t.outcome === "LOSS").length,
      ties: items.filter((t) => t.outcome === "TIE").length,
      pending: items.filter((t) => t.status === "PENDING").length,
      coverage: o ? items.length / o : null,
    };
  });
}
