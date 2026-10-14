import { z } from "zod";
import { RuleOverridesSchema } from "../config/rules";

export const MarketTypeSchema = z.enum(["LIVE", "OTC"]);
export const ProviderIdSchema = z.string().regex(/^[a-z0-9-]{2,32}$/, "invalid provider id");
/** e.g. EUR/USD, XAU/USD, SAMPLE-TREND */
export const SymbolSchema = z.string().trim().min(3).max(20).regex(/^[A-Za-z0-9/._-]+$/, "invalid symbol");

export const SymbolsQuerySchema = z.object({
  provider: ProviderIdSchema,
  marketType: MarketTypeSchema,
});

export const SignalModeSchema = z.enum(["V4", "V2", "STRICT", "NORMAL", "FAST"]);

export const AnalyzeRequestSchema = z.strictObject({
  provider: ProviderIdSchema,
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  mode: SignalModeSchema.default("V2"),
  rules: RuleOverridesSchema.optional(),
});

export const BacktestRequestSchema = z.strictObject({
  provider: ProviderIdSchema,
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  /** Fraction: 0.85 = 85% payout */
  payout: z.number().gt(0).max(2),
  count: z.number().int().min(300).max(5000).default(1500),
  inSampleFraction: z.number().min(0.3).max(0.9).default(0.7),
  mode: SignalModeSchema.default("V2"),
});

export const ResolveRequestSchema = z.strictObject({
  provider: ProviderIdSchema,
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  signals: z
    .array(z.strictObject({ id: z.string().min(1).max(64), signalCandleTime: z.number().int().positive(), decision: z.enum(["CALL", "PUT"]) }))
    .min(1)
    .max(50),
});

export const OutcomeSchema = z.enum(["UNRESOLVED", "WIN", "LOSS", "TIE"]);

export const JournalCreateSchema = z.strictObject({
  source: z.string().min(2).max(64),
  pair: SymbolSchema,
  marketType: MarketTypeSchema,
  analysisKind: z.enum(["LIVE_FEED", "SAMPLE", "SCREENSHOT"]),
  decision: z.enum(["CALL", "PUT", "NO_TRADE"]),
  engineDecision: z.enum(["CALL", "PUT", "NO_TRADE"]),
  signalCandleTime: z.iso.datetime().nullable(),
  entryReference: z.number().positive().nullable(),
  expirySeconds: z.literal(60),
  agreementScore: z.number().min(-1).max(1),
  ruleVersion: z.string().max(32),
  evidence: z.array(z.object({ id: z.string().max(64), direction: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]), weight: z.number(), detail: z.string().max(300) })).max(40),
  reasons: z.array(z.string().max(300)).max(40),
  isDemo: z.literal(true).default(true),
  notes: z.string().max(1000).optional(),
});

export const JournalOutcomeSchema = z.strictObject({
  outcome: OutcomeSchema,
  entryDelaySeconds: z.number().int().min(0).max(3600).nullable().optional(),
  resultSource: z.enum(["UNVERIFIED", "BROKER_MANUAL", "FEED_ESTIMATE"]).optional(),
  entryPrice: z.number().positive().nullable().optional(),
  exitPrice: z.number().positive().nullable().optional(),
  payoutPercent: z.number().gt(0).max(200).nullable().optional(),
  notes: z.string().max(1000).optional(),
});

export const LoginSchema = z.strictObject({ email: z.email().max(254) });

export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
