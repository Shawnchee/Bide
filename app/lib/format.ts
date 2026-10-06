import type { U64ish } from "./types";

export function toBig(v: U64ish | null | undefined): bigint | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    return BigInt(v);
  } catch {
    return null;
  }
}

/** Base units → JS number of whole tokens (display only, never for tx math). */
export function fromBase(v: U64ish | null | undefined, decimals: number): number | null {
  const b = toBig(v);
  if (b === null) return null;
  return Number(b) / 10 ** decimals;
}

const usdFmt = (min: number, max: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: min, maximumFractionDigits: max });

/** Dollars (number) → "$1,234.56"; small values keep cents precision. */
export function usd(n: number | null | undefined, opts: { whole?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (opts.whole) return usdFmt(0, 0).format(n);
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return usdFmt(4, 4).format(n);
  return usdFmt(2, 2).format(n);
}

/** Strike/price in USDC base units → "$112" / "$119.40" (keeps tick precision). */
export function usdcPrice(v: U64ish | null | undefined): string {
  const n = fromBase(v, 6);
  if (n === null) return "—";
  const cents = Math.round(n * 100) % 100 !== 0;
  return `$${n.toLocaleString("en-US", cents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 })}`;
}

/** USDC base units (6 dp) → "$12.34". */
export function usdc(v: U64ish | null | undefined, opts: { whole?: boolean } = {}): string {
  return usd(fromBase(v, 6), opts);
}

export function tokenAmount(n: number | null | undefined, symbol: string, maxDp = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return `— ${symbol}`;
  const s = new Intl.NumberFormat("en-US", { maximumFractionDigits: maxDp }).format(n);
  return `${s} ${symbol}`;
}

export function pct(n: number | null | undefined, dp = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(dp)}%`;
}

export function shortAddr(a: string | null | undefined, chars = 4): string {
  if (!a) return "—";
  if (a.length <= chars * 2 + 3) return a;
  return `${a.slice(0, chars)}…${a.slice(-chars)}`;
}

export function toUnix(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function dateShort(unix: number | null | undefined): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dateTimeUtc(unix: number | null | undefined): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${d
    .toISOString()
    .slice(11, 16)} UTC`;
}

export function timeAgo(iso: string | number | null | undefined): string {
  if (!iso) return "—";
  const t = typeof iso === "number" ? (iso > 1e12 ? iso : iso * 1000) : Date.parse(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(secs: number): string {
  if (secs <= 0) return "0s";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}
