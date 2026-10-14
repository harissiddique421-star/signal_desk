import { z } from "zod";
import { JournalOutcomeSchema } from "@/lib/api/schemas";
import { audit } from "@/lib/server/audit";
import { enforceRateLimit, HttpError, json, readJson, safe } from "@/lib/server/http";
import { requireUser } from "@/lib/server/supabase";

const IdSchema = z.uuid();

/** Record the observed outcome of a demo signal. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return safe(async () => {
    enforceRateLimit(req, "journal-write", 30);
    const id = IdSchema.parse((await ctx.params).id);
    const body = JournalOutcomeSchema.parse(await readJson(req));
    const { sb, user } = await requireUser();
    const { data, error } = await sb
      .from("signal_records")
      .update({
        outcome: body.outcome,
        entry_price: body.entryPrice ?? null,
        exit_price: body.exitPrice ?? null,
        payout_percent: body.payoutPercent ?? null,
        entry_delay_seconds: body.entryDelaySeconds ?? null,
        result_source: body.resultSource ?? "UNVERIFIED",
        notes: body.notes ?? null,
        resolved_at: body.outcome === "UNRESOLVED" ? null : new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();
    if (error) throw new HttpError(502, "Could not update the record");
    if (!data) throw new HttpError(404, "Record not found");
    await audit({ action: "journal.outcome", userId: user.id, entity: "signal_records", entityId: id, metadata: { outcome: body.outcome } }, sb);
    return json({ id, outcome: body.outcome });
  });
}
