export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  return n.toFixed(abs >= 1000 ? 2 : abs >= 10 ? 3 : 5);
}

export function fmtTime(ms: number | null | undefined, withSeconds = false): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
}

export function fmtDateTime(ms: number | string | null | undefined): string {
  if (!ms) return "—";
  const d = typeof ms === "string" ? new Date(ms) : new Date(ms);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtUnits(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
}

export const tzName = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "local time";
  }
};
