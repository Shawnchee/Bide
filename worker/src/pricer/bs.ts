// Black-Scholes / Black-76 with r = 0 (so forward = spot). Pure functions.
export type OptType = "put" | "call";
export const YEAR_SECS = 365 * 86400;

// Abramowitz-Stegun 7.1.26-based erf; |error| < 1.5e-7, plenty for premiums.
function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
export const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Undiscounted Black price (r = 0) per unit of underlying. T in years. */
export function blackPrice(type: OptType, F: number, K: number, T: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === "call" ? F - K : K - F);
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return type === "call" ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
}

/** Probability the option finishes in the money under the pricing measure (N(d2)-style). */
export function itmProbability(type: OptType, F: number, K: number, T: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return (type === "call" ? F > K : F < K) ? 1 : 0;
  const sd = sigma * Math.sqrt(T);
  const d2 = (Math.log(F / K) - 0.5 * sd * sd) / sd;
  return type === "call" ? normCdf(d2) : normCdf(-d2);
}

/** Implied vol by bisection. Returns undefined if price is outside the no-arbitrage range. */
export function impliedVol(type: OptType, price: number, F: number, K: number, T: number): number | undefined {
  if (!(price > 0) || !(T > 0)) return undefined;
  const intrinsic = Math.max(0, type === "call" ? F - K : K - F);
  const upper = type === "call" ? F : K;
  if (price <= intrinsic + 1e-12 || price >= upper) return undefined;
  let lo = 1e-4, hi = 10;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (blackPrice(type, F, K, T, mid) > price) hi = mid; else lo = mid;
    if (hi - lo < 1e-7) break;
  }
  return 0.5 * (lo + hi);
}
