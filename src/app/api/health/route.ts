import { connection } from "next/server";
import { allProviders, liveDataAvailable } from "@/lib/providers/registry";
import { json, safe } from "@/lib/server/http";
import { serverEnv, supabaseConfigured } from "@/lib/server/env";

/** Source-health and capability report. Never includes secrets. */
export async function GET() {
  await connection();
  return safe(async () => {
    const providers = await Promise.all(allProviders().map((p) => p.health()));
    return json({
      serverTime: Date.now(),
      liveDataAvailable: liveDataAvailable(),
      otcDataAvailable: false,
      otcNote: "No permitted provider publishes broker OTC quotes. OTC can only be reviewed from screenshots, which are not tradable signals.",
      newsFilterAvailable: false,
      screenshotInterpretation: "NOT_IMPLEMENTED",
      accountsEnabled: supabaseConfigured(serverEnv()),
      providers,
    });
  });
}
