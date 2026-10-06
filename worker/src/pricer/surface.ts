// Filters + per-venue interpolation. Pure functions over normalised quotes (BUILD §4.1 steps 2–4).
import { YEAR_SECS } from "./bs.js";
import type { Quote, Venue } from "./types.js";

export const MAX_QUOTE_AGE_MS = 30_000;
export const MAX_SPREAD_VOL = 0.10; // 10 vol points
const SAME_EXPIRY_MS = 60_000;

export type DropReason = "stale" | "no_bid" | "no_ask" | "wide_spread" | "expired";
export interface FilterResult { kept: Quote[]; dropped: Record<DropReason, number> }

export function filterQuotes(quotes: Quote[], now: number): FilterResult {
  const dropped: Record<DropReason, number> = { stale: 0, no_bid: 0, no_ask: 0, wide_spread: 0, expired: 0 };
  const kept: Quote[] = [];
  for (const q of quotes) {
    if (q.expiry <= now) dropped.expired++;
    else if (now - q.ts > MAX_QUOTE_AGE_MS) dropped.stale++;
    else if (q.bidIv === undefined) dropped.no_bid++;
    else if (q.askIv === undefined) dropped.no_ask++;
    else if (q.askIv - q.bidIv > MAX_SPREAD_VOL || q.askIv < q.bidIv) dropped.wide_spread++;
    else kept.push(q);
  }
  return { kept, dropped };
}

export interface SmilePoint { k: number; strike: number; bid: number; mid: number; instrument: string }
export interface Smile { expiry: number; forward: number; points: SmilePoint[] }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};
export { median };

/** One smile per expiry. Per strike prefer the OTM option (put below F, call at/above F), else the other side. */
export function buildSmiles(kept: Quote[]): Smile[] {
  const byExp = new Map<number, Quote[]>();
  for (const q of kept) {
    const arr = byExp.get(q.expiry) ?? [];
    arr.push(q);
    byExp.set(q.expiry, arr);
  }
  const smiles: Smile[] = [];
  for (const [expiry, qs] of byExp) {
    const F = median(qs.map((q) => q.forward));
    const byStrike = new Map<number, Quote[]>();
    for (const q of qs) byStrike.set(q.strike, [...(byStrike.get(q.strike) ?? []), q]);
    const points: SmilePoint[] = [];
    for (const [strike, arr] of byStrike) {
      const otmType = strike < F ? "put" : "call";
      const q = arr.find((x) => x.type === otmType) ?? arr[0]!;
      points.push({ k: Math.log(strike / F), strike, bid: q.bidIv!, mid: (q.bidIv! + q.askIv!) / 2, instrument: q.instrument });
    }
    points.sort((a, b) => a.k - b.k);
    smiles.push({ expiry, forward: F, points });
  }
  return smiles.sort((a, b) => a.expiry - b.expiry);
}

/** Linear interpolation of bid/mid IV in log-moneyness. No extrapolation outside listed strikes. */
export function interpSmile(s: Smile, strike: number): { bid: number; mid: number } | undefined {
  const k = Math.log(strike / s.forward);
  const p = s.points;
  if (p.length === 0 || k < p[0]!.k - 1e-12 || k > p[p.length - 1]!.k + 1e-12) return undefined;
  for (let i = 0; i < p.length; i++) {
    if (Math.abs(p[i]!.k - k) < 1e-12) return { bid: p[i]!.bid, mid: p[i]!.mid };
    if (i + 1 < p.length && p[i]!.k <= k && k <= p[i + 1]!.k) {
      const w = (k - p[i]!.k) / (p[i + 1]!.k - p[i]!.k);
      return { bid: p[i]!.bid + w * (p[i + 1]!.bid - p[i]!.bid), mid: p[i]!.mid + w * (p[i + 1]!.mid - p[i]!.mid) };
    }
  }
  return undefined;
}

export type IvMethod = "exact" | "total_variance" | "flat_nearest";
export interface VenueIv {
  venue: Venue;
  bidIv: number;
  midIv: number;
  method: IvMethod;
  expiriesUsed: number[];
  forward: number;
  quotesKept: number;
}
export interface VenueReject { venue: Venue; reason: string }

/**
 * IV for (strike, expiry) on one venue.
 * - exact listed expiry → smile value
 * - between listed expiries → linear in total variance w = σ²T (bid and mid separately)
 * - below the shortest listed expiry → only if `quick`: flat IV of the nearest expiry (flagged)
 * - otherwise (beyond longest, or strike outside listed range) → rejected
 */
export function venueIv(venue: Venue, kept: Quote[], strike: number, expiry: number, now: number, quick: boolean): VenueIv | VenueReject {
  const smiles = buildSmiles(kept);
  if (smiles.length === 0) return { venue, reason: "no usable quotes" };
  const T = (expiry - now) / 1000 / YEAR_SECS;
  if (T <= 0) return { venue, reason: "expiry in the past" };
  const vals = smiles.map((s) => ({ s, v: interpSmile(s, strike), T: (s.expiry - now) / 1000 / YEAR_SECS }));
  const base = { venue, quotesKept: kept.length };

  const exact = vals.find((x) => Math.abs(x.s.expiry - expiry) < SAME_EXPIRY_MS);
  if (exact) {
    if (!exact.v) return { venue, reason: "strike outside listed range at this expiry" };
    return { ...base, bidIv: exact.v.bid, midIv: exact.v.mid, method: "exact", expiriesUsed: [exact.s.expiry], forward: exact.s.forward };
  }
  const shortest = smiles[0]!.expiry;
  if (expiry < shortest) {
    if (!quick) return { venue, reason: "below shortest expiry with usable quotes (std plan)" };
    const nearest = vals.find((x) => x.v);
    if (!nearest) return { venue, reason: "strike outside listed range" };
    return { ...base, bidIv: nearest.v!.bid, midIv: nearest.v!.mid, method: "flat_nearest", expiriesUsed: [nearest.s.expiry], forward: nearest.s.forward };
  }
  const lower = [...vals].reverse().find((x) => x.s.expiry < expiry && x.v);
  const upper = vals.find((x) => x.s.expiry > expiry && x.v);
  if (!upper) return { venue, reason: "beyond longest listed expiry with this strike" };
  if (!lower) return { venue, reason: "no shorter expiry covers this strike" };
  const tv = (a: number, b: number) => {
    const w1 = a * a * lower.T, w2 = b * b * upper.T;
    const w = w1 + ((w2 - w1) * (T - lower.T)) / (upper.T - lower.T);
    return Math.sqrt(Math.max(w, 0) / T);
  };
  return {
    ...base, bidIv: tv(lower.v!.bid, upper.v!.bid), midIv: tv(lower.v!.mid, upper.v!.mid),
    method: "total_variance", expiriesUsed: [lower.s.expiry, upper.s.expiry], forward: lower.s.forward,
  };
}
