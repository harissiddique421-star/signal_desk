import { DEFAULT_RULES, RuleConfigSchema } from "../config/rules";
import { MODE_OVERRIDES, type SignalMode } from "../config/presets";
import { shadowPredict, SHADOW_MODEL_VERSION } from "../ml/model";
import type { Decision, SignalResult } from "../types";
import { closedCandlesOnly } from "../validation/candles";
import { evaluateSignal, type EngineInput } from "./signal";

export type ShadowVersion = "rules-v2-fade" | "v3-ml-shadow";

/** What a version WOULD have said on the same candles at the same moment. Never shown as a signal. */
export interface ShadowDecision {
  version: ShadowVersion;
  label: string;
  decision: Decision;
  /** Calibrated probability of an up-candle (model versions only) */
  probability: number | null;
  /** True when the data/source gates passed, i.e. this minute was a real opportunity */
  eligible: boolean;
  reason: string;
}

const V2_VERSION = MODE_OVERRIDES.V2.version as "rules-v2-fade";

/**
 * Shadow mode: evaluate the comparison versions on exactly the candles the active
 * analysis used. Data problems fail closed to NO_TRADE for every version.
 */
export function shadowDecisions(input: EngineInput, activeMode: SignalMode, active: SignalResult): ShadowDecision[] {
  const gateFailed = active.checks.find((c) => !c.passed && (c.id.startsWith("data.") || c.id.startsWith("source.")));
  const eligible = !gateFailed && active.signalCandleTime !== null;
  const out: ShadowDecision[] = [];

  const v2 = activeMode === "V2" ? active : evaluateSignal({ ...input, config: RuleConfigSchema.parse({ ...DEFAULT_RULES, ...MODE_OVERRIDES.V2 }) });
  out.push({
    version: V2_VERSION,
    label: "v2 Fade",
    decision: v2.engineDecision === "NO_TRADE" || !eligible ? "NO_TRADE" : v2.engineDecision,
    probability: null,
    eligible,
    reason: v2.reasons[0] ?? "All v2 rules passed",
  });

  let v3: ShadowDecision = { version: SHADOW_MODEL_VERSION as ShadowVersion, label: "v3 ML (shadow)", decision: "NO_TRADE", probability: null, eligible, reason: gateFailed ? `${gateFailed.label}: ${gateFailed.detail}` : "" };
  if (eligible && active.marketType === "LIVE") {
    const closed = closedCandlesOnly(input.candles, 60_000, input.now).slice(-300);
    const p = shadowPredict(closed, input.symbol);
    if (!p) v3 = { ...v3, eligible: false, reason: "Model not trained for this pair or not enough clean history" };
    else {
      const timingOk = active.checks.find((c) => c.id === "timing.window")?.passed ?? true;
      v3 = {
        ...v3,
        decision: timingOk ? p.decision : "NO_TRADE",
        probability: Math.round(p.probability * 1e4) / 1e4,
        reason: !timingOk ? "Entry window passed" : p.decision === "NO_TRADE" ? `p(up) ${(p.probability * 100).toFixed(1)}% inside the no-trade margin` : `p(up) ${(p.probability * 100).toFixed(1)}%`,
      };
    }
  } else if (active.marketType !== "LIVE") {
    v3 = { ...v3, eligible: false, reason: "No OTC model (no OTC data exists to train one)" };
  }
  out.push(v3);
  return out;
}
