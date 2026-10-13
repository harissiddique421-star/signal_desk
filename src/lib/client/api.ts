import type { ApiError } from "../api/contracts";

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string; offline?: boolean };

/** Fetch JSON from our own API. Never throws; network failures come back as `offline`. */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<Result<T>> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: json !== undefined ? { "content-type": "application/json", ...(rest.headers ?? {}) } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, error: "Network unavailable — check your connection.", offline: true };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = body as ApiError | null;
    const detail = e?.issues?.length ? `: ${e.issues.map((i) => `${i.path || "body"} ${i.message}`).join("; ")}` : "";
    return { ok: false, status: res.status, error: (e?.error ?? `Request failed (${res.status})`) + detail };
  }
  return { ok: true, data: body as T };
}
