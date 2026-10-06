/** Deterministic unit helpers (bigint only — no float money math). */

export const USDC_DECIMALS = 6;

export function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** Format base units as a fixed decimal string, trimmed to `maxFrac` digits (rounded down). */
export function formatUnits(v: string | bigint, decimals: number, maxFrac = decimals): string {
  const b = typeof v === "bigint" ? v : BigInt(v);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const whole = a / pow10(decimals);
  let frac = (a % pow10(decimals)).toString().padStart(decimals, "0").slice(0, maxFrac);
  frac = frac.replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** "$1,234.56" from USDC base units, rounded DOWN to cents. */
export function usd(v: string | bigint): string {
  const b = typeof v === "bigint" ? v : BigInt(v);
  const cents = b / 10_000n; // 6 → 2 decimals
  const whole = cents / 100n;
  const c = (cents % 100n).toString().padStart(2, "0");
  return "$" + whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + c;
}

/** "$110" when whole dollars, else "$110.50". */
export function usdPrice(v: string | bigint): string {
  const s = usd(v);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
}

/** Notional (USDC base units) = strike × size / 10^decimals, rounded down or up. */
export function notional(strike: string | bigint, size: string | bigint, assetDecimals: number, round: "down" | "up" = "down"): bigint {
  const n = BigInt(strike) * BigInt(size);
  const d = pow10(assetDecimals);
  const q = n / d;
  return round === "up" && n % d !== 0n ? q + 1n : q;
}

/**
 * Smallest premium_floor the program accepts for the user's minimum yield (BUILD §3.3 open_round):
 *   floor × (10_000 − fee_bps) / 10_000 ≥ notional × bps_per_day × secs / (86_400 × 10_000)
 */
export function userMinPremiumFloor(args: { notional: bigint; minBpsPerDay: number; secsToExpiry: number; feeBps: number }): bigint {
  const secs = BigInt(Math.max(0, Math.floor(args.secsToExpiry)));
  const need = args.notional * BigInt(args.minBpsPerDay) * secs; // ÷ (86_400 × 10_000)
  const den = 86_400n * 10_000n;
  const afterFee = (need + den - 1n) / den; // after-fee amount, rounded up
  const keep = 10_000n - BigInt(args.feeBps);
  if (keep <= 0n) return 0n;
  return (afterFee * 10_000n + keep - 1n) / keep;
}

export function afterFee(premium: string | bigint, feeBps: number): bigint {
  const p = BigInt(premium);
  return p - (p * BigInt(feeBps)) / 10_000n;
}

/** Ratio as a JS number with 4 decimals (for display / model context only). */
export function ratio(a: bigint, b: bigint): number | null {
  if (b === 0n) return null;
  return Number((a * 10_000n) / b) / 10_000;
}

export function pctChange(from: bigint, to: bigint): number | null {
  if (from === 0n) return null;
  return Number(((to - from) * 1_000_000n) / from) / 10_000; // percent with 4 decimals
}
