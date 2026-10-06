const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
/** All four venues expire SOL/BTC options at 08:00 UTC. */
export const EXPIRY_HOUR_UTC = 8;

/** "7OCT26" / "25DEC26" → ms at 08:00 UTC. */
export function parseDdMmmYy(s: string): number | undefined {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(s);
  if (!m) return undefined;
  const mon = MONTHS[m[2]!];
  if (mon === undefined) return undefined;
  return Date.UTC(2000 + Number(m[3]), mon, Number(m[1]), EXPIRY_HOUR_UTC);
}
/** "261007" → ms at 08:00 UTC. */
export function parseYyMmDd(s: string): number | undefined {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return undefined;
  return Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), EXPIRY_HOUR_UTC);
}
/** Strike strings; Deribit writes decimals as "1d5". */
export function parseStrike(s: string): number | undefined {
  const v = Number(s.replace("d", "."));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}
export function parseType(s: string): "put" | "call" | undefined {
  return s === "P" ? "put" : s === "C" ? "call" : undefined;
}
/** Positive finite number or undefined ("0", "", "-1" → undefined). */
export function pos(v: unknown, min = 0): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > min ? n : undefined;
}

export async function getJson(url: string, timeoutMs = 8000, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}${new URL(url).pathname}`);
  return res.json();
}
