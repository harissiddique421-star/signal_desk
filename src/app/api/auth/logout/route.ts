import { audit } from "@/lib/server/audit";
import { json, safe } from "@/lib/server/http";
import { supabaseForRequest } from "@/lib/server/supabase";

export async function POST() {
  return safe(async () => {
    const sb = await supabaseForRequest();
    if (sb) {
      const { data } = await sb.auth.getUser();
      if (data.user) await audit({ action: "auth.logout", userId: data.user.id }, sb);
      await sb.auth.signOut();
    }
    return json({ ok: true });
  });
}
