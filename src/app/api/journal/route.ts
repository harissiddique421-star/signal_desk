import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { JournalCreateSchema } from "@/lib/api/schemas";
import { summarize, type Outcome } from "@/lib/stats/performance";
import { audit } from "@/lib/server/audit";
import { enforceRateLimit, HttpError, json, readJson, safe } from "@/lib/server/http";
import { requireUser } from "@/lib/server/supabase";

const ListQuery = z.object({
  payout: z.coerce.number().gt(0).max(2).default(0.8),
  kind: z.enum(["LIVE_FEED", "SAMPLE", "SCREENSHOT", "ALL"]).default("ALL"),
});

/** List the signed-in user's journal entries plus a payout-aware summary. */
export async function GET(req: NextRequest) {
  await connection();
  return safe(async () => {
    enforceRateLimit(req, "journal-read", 60);
    const q = ListQuery.parse(Object.fromEntries(req.nextUrl.searchParams));
    const { sb, user } = await requireUser();
    let query = sb.from("signal_records").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(500);
    if (q.kind !== "ALL") query = query.eq("analysis_kind", q.kind);
    const { data, error } = await query;
    if (error) throw new HttpError(502, "Could not load journal");
    const tradable = (data ?? []).filter((r) => r.decision !== "NO_TRADE");
    const summary = summarize(
      tradable.map((r) => ({ time: Date.parse(r.created_at), outcome: r.outcome as Outcome })),
      q.payout,
    );
    return json({ records: data ?? [], summary });
  });
}

export async function POST(req: Request) {
  return safe(async () => {
    enforceRateLimit(req, "journal-write", 30);
    const body = JournalCreateSchema.parse(await readJson(req));
    const { sb, user } = await requireUser();
    const { data, error } = await sb
      .from("signal_records")
      .insert({
        user_id: user.id,
        source: body.source,
        pair: body.pair,
        market_type: body.marketType,
        analysis_kind: body.analysisKind,
        decision: body.decision,
        engine_decision: body.engineDecision,
        signal_candle_time: body.signalCandleTime,
        entry_reference: body.entryReference,
        expiry_seconds: body.expirySeconds,
        agreement_score: body.agreementScore,
        rule_version: body.ruleVersion,
        evidence: body.evidence,
        reasons: body.reasons,
        is_demo: body.isDemo,
        notes: body.notes ?? null,
      })
      .select("id")
      .single();
    if (error || !data) throw new HttpError(502, "Could not save the record");
    await audit({ action: "journal.create", userId: user.id, entity: "signal_records", entityId: data.id, metadata: { decision: body.decision, kind: body.analysisKind } }, sb);
    return json({ id: data.id }, { status: 201 });
  });
}
