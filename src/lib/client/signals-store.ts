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
  mode: "STRICT" | "NORMAL";
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
      window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, 500)));
    } catch {
      /* storage unavailable */
    }
  },
};

export interface SimpleSettings {
  mode: "STRICT" | "NORMAL";
  sound: boolean;
  payoutPercent: number;
  symbol: string | null;
}

const SKEY = "signal-desk:simple-settings:v1";
export const DEFAULT_SIMPLE: SimpleSettings = { mode: "NORMAL", sound: true, payoutPercent: 85, symbol: null };

export const simpleSettingsStore = {
  load(): SimpleSettings {
    try {
      const raw = window.localStorage.getItem(SKEY);
      return { ...DEFAULT_SIMPLE, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      return DEFAULT_SIMPLE;
    }
  },
  save(s: SimpleSettings) {
    try {
      window.localStorage.setItem(SKEY, JSON.stringify(s));
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
