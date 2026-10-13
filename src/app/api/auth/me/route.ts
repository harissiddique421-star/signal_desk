import { connection } from "next/server";
import { json, safe } from "@/lib/server/http";
import { supabaseForRequest } from "@/lib/server/supabase";

/** Minimal session info for the UI. Only the email is returned. */
export async function GET() {
  await connection();
  return safe(async () => {
    const sb = await supabaseForRequest();
    if (!sb) return json({ accountsEnabled: false, user: null });
    const { data } = await sb.auth.getUser();
    return json({ accountsEnabled: true, user: data.user ? { email: data.user.email ?? null } : null });
  });
}
