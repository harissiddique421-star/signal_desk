import type { Outcome } from "../stats/performance";
import type { AnalysisKind, Decision, MarketType } from "../types";

/** Journal entry kept in this browser when accounts are not configured or the user is signed out. */
export interface LocalJournalEntry {
  id: string;
  createdAt: string;
  source: string;
  pair: string;
  marketType: MarketType;
  analysisKind: AnalysisKind;
  decision: Decision;
  engineDecision: Decision;
  signalCandleTime: string | null;
  entryReference: number | null;
  agreementScore: number;
  ruleVersion: string;
  outcome: Outcome;
  notes?: string;
}

export interface LocalSettings {
  payoutPercent: number;
  sound: boolean;
  autoRefresh: boolean;
}

export const DEFAULT_SETTINGS: LocalSettings = { payoutPercent: 80, sound: false, autoRefresh: false };

const JOURNAL_KEY = "signal-desk:journal:v1";
const SETTINGS_KEY = "signal-desk:settings:v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const localJournal = {
  load: (): LocalJournalEntry[] => {
    const v = read<unknown>(JOURNAL_KEY, []);
    return Array.isArray(v) ? (v as LocalJournalEntry[]) : [];
  },
  save: (entries: LocalJournalEntry[]) => write(JOURNAL_KEY, entries.slice(0, 1000)),
};

export const localSettings = {
  load: (): LocalSettings => ({ ...DEFAULT_SETTINGS, ...read<Partial<LocalSettings>>(SETTINGS_KEY, {}) }),
  save: (s: LocalSettings) => write(SETTINGS_KEY, s),
};
