import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { audit } from "@/lib/server/audit";
import { supabaseForRequest } from "@/lib/server/supabase";

/** Magic-link landing: exchange the one-time code for a session cookie, then go home. */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const home = new URL("/", req.nextUrl.origin);
  const sb = await supabaseForRequest();
  if (!sb || !code || code.length > 512) {
    home.searchParams.set("auth", "failed");
    return NextResponse.redirect(home);
  }
  const { data, error } = await sb.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    home.searchParams.set("auth", "failed");
    return NextResponse.redirect(home);
  }
  await audit({ action: "auth.login", userId: data.user.id }, sb);
  return NextResponse.redirect(home);
}
