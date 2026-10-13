import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AuditEvent {
  action: string;
  userId?: string | null;
  entity?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit record. Always emits a structured log line (no secrets, no
 * request bodies). When a user-scoped Supabase client is available the event
 * is also stored in `audit_logs` (insert-only under RLS).
 */
export async function audit(event: AuditEvent, sb?: SupabaseClient | null) {
  console.info(JSON.stringify({ level: "audit", at: new Date().toISOString(), ...event }));
  if (!sb || !event.userId) return;
  const { error } = await sb.from("audit_logs").insert({
    user_id: event.userId,
    action: event.action,
    entity: event.entity ?? null,
    entity_id: event.entityId ?? null,
    metadata: event.metadata ?? {},
  });
  if (error) console.error(JSON.stringify({ level: "error", message: "audit insert failed", code: error.code }));
}
