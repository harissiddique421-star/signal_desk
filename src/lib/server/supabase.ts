import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { serverEnv, supabaseConfigured } from "./env";
import { HttpError } from "./http";

/**
 * Per-request Supabase client using the PUBLIC anon key + the user's session
 * cookie. Every query therefore runs as the signed-in user and is constrained
 * by row-level security. No service-role key is used anywhere in this app.
 */
export async function supabaseForRequest() {
  const env = serverEnv();
  if (!supabaseConfigured(env)) return null;
  const store = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) store.set(name, value, options);
      },
    },
  });
}

/** Resolve the signed-in user or throw a safe 401/503. */
export async function requireUser() {
  const sb = await supabaseForRequest();
  if (!sb) throw new HttpError(503, "Accounts and saved history are not configured on this deployment (Supabase env vars missing).");
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Sign in required");
  return { sb, user: data.user };
}
