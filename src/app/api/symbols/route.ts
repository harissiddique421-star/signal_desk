import { connection, type NextRequest } from "next/server";
import { SymbolsQuerySchema } from "@/lib/api/schemas";
import { resolveProvider } from "@/lib/server/analysis-service";
import { enforceRateLimit, json, safe } from "@/lib/server/http";

export async function GET(req: NextRequest) {
  await connection();
  return safe(async () => {
    enforceRateLimit(req, "symbols", 30);
    const q = SymbolsQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
    const p = resolveProvider(q.provider);
    const symbols = await p.listSymbols(q.marketType);
    return json({ provider: p.id, marketType: q.marketType, verified: p.verified, symbols });
  });
}
