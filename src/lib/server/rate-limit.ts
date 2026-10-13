/**
 * Fixed-window in-memory rate limiter.
 *
 * Limitation (documented in README): on serverless platforms each instance has
 * its own memory, so the effective limit is per instance. For strict global
 * limits put a shared store (e.g. Redis) behind the same interface.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  check(key: string): RateLimitResult {
    const now = this.clock();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const entry = this.hits.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      this.hits.set(key, { count: 1, windowStart });
      this.sweep(windowStart);
      return { allowed: true, remaining: this.limit - 1, resetAt: windowStart + this.windowMs };
    }
    entry.count++;
    return { allowed: entry.count <= this.limit, remaining: Math.max(0, this.limit - entry.count), resetAt: windowStart + this.windowMs };
  }

  private sweep(currentWindow: number) {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.windowStart !== currentWindow) this.hits.delete(k);
  }
}

/** Best-effort client identifier from proxy headers (Vercel sets x-forwarded-for). */
export function clientKey(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
  return ip.slice(0, 64);
}
