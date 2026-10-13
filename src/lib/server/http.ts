import "server-only";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { ProviderError } from "../providers/types";
import { clientKey, RateLimiter } from "./rate-limit";
import { serverEnv } from "./env";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

const limiters = new Map<string, RateLimiter>();

/** Throws HttpError(429) when `bucket` is over its per-minute budget for this client. */
export function enforceRateLimit(req: Request, bucket: string, perMinute?: number) {
  const limit = perMinute ?? serverEnv().RATE_LIMIT_PER_MINUTE;
  let l = limiters.get(bucket);
  if (!l) {
    l = new RateLimiter(limit, 60_000);
    limiters.set(bucket, l);
  }
  const r = l.check(clientKey(req.headers));
  if (!r.allowed) throw new HttpError(429, `Too many requests. Try again in ${Math.ceil((r.resetAt - Date.now()) / 1000)}s.`);
}

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) } });
}

/** Wrap a handler so every failure becomes a safe, structured JSON error. */
export async function safe(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (e) {
    unstable_rethrow(e); // let Next.js control-flow errors (prerender bail-out, redirects) pass through
    if (e instanceof ZodError) {
      return json({ error: "Invalid request", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
    }
    if (e instanceof HttpError) return json({ error: e.publicMessage }, { status: e.status });
    if (e instanceof ProviderError) return json({ error: e.publicMessage, providerError: true }, { status: e.status });
    if (e instanceof SyntaxError) return json({ error: "Malformed JSON body" }, { status: 400 });
    const id = crypto.randomUUID();
    console.error(JSON.stringify({ level: "error", id, message: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Internal error", requestId: id }, { status: 500 });
  }
}

export async function readJson(req: Request, maxBytes = 32_768): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, "Request body too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request body too large");
  return JSON.parse(text);
}
