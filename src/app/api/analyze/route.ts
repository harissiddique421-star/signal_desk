import { AnalyzeRequestSchema } from "@/lib/api/schemas";
import { analyze } from "@/lib/server/analysis-service";
import { enforceRateLimit, json, readJson, safe } from "@/lib/server/http";

export async function POST(req: Request) {
  return safe(async () => {
    enforceRateLimit(req, "analyze");
    const body = AnalyzeRequestSchema.parse(await readJson(req));
    const out = await analyze({ providerId: body.provider, symbol: body.symbol, marketType: body.marketType, rules: body.rules });
    return json(out);
  });
}
