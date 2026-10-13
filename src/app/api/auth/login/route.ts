import { LoginSchema } from "@/lib/api/schemas";
import { audit } from "@/lib/server/audit";
import { enforceRateLimit, HttpError, json, readJson, safe } from "@/lib/server/http";
import { supabaseForRequest } from "@/lib/server/supabase";

/** Send a passwordless sign-in link. Response is identical whether or not the email exists. */
export async function POST(req: Request) {
  return safe(async () => {
    enforceRateLimit(req, "auth-login", 5);
    const { email } = LoginSchema.parse(await readJson(req));
    const sb = await supabaseForRequest();
    if (!sb) throw new HttpError(503, "Accounts are not configured on this deployment.");
    const origin = new URL(req.url).origin;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${origin}/auth/callback` } });
    if (error && error.status !== 429) console.error(JSON.stringify({ level: "error", message: "otp send failed", code: error.code }));
    if (error?.status === 429) throw new HttpError(429, "Too many sign-in attempts. Please wait and try again.");
    await audit({ action: "auth.link_requested" });
    return json({ ok: true, message: "If the address is valid, a sign-in link has been sent." });
  });
}
