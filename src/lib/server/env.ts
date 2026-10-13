import "server-only";
import { z } from "zod";

/**
 * Server-only environment. Never import this from a client component —
 * the `server-only` import makes that a build error.
 */
const EnvSchema = z.object({
  TWELVEDATA_API_KEY: z.string().min(8).optional(),
  ENABLE_SAMPLE_PROVIDER: z.enum(["true", "false"]).default("true"),
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(30),
});

export type ServerEnv = z.infer<typeof EnvSchema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const raw = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]));
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // Report which variables are wrong, never their values.
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server environment variables: ${keys}`);
  }
  cached = parsed.data;
  return cached;
}

export function supabaseConfigured(env = serverEnv()): boolean {
  return !!env.NEXT_PUBLIC_SUPABASE_URL && !!env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}
