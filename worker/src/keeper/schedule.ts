// Epoch schedule + auction windows — mirrors BUILD §3.2 code constants EXACTLY.
import { EPOCH_PARAMS } from "@bide/shared";
export const DAY = 86_400;
export const STD_EXPIRY_SECS_OF_DAY = 28_800; // 08:00 UTC
export const STD_AUCTION_WINDOW_SECS = 1_800; // first 30 min after 08:00 UTC
export const STD_MIN_SECS_TO_EXPIRY = 12 * 3_600;
export const QUICK_PERIOD_SECS = 600;
export const QUICK_AUCTION_OPEN_OFFSET = 600; // window = [expiry − 600, expiry − 540]
export const QUICK_AUCTION_CLOSE_OFFSET = 540;
export const MAX_EPOCH_AHEAD_SECS = 180 * DAY;

/**
 * Valuation time (unix secs) for pricing a round on `expiry`. A quick round can only open at or after the auction
 * window start (expiry − 600 s), so the desk — which runs ~180 s before the window — must price it as of
 * max(now, expiry − 600), not now: pricing from now adds ~3 min of time value the round never has, which put the
 * floor above the makers' fair at take time (notes/stress-test.md "Fill rate"). Std rounds open at the desk run → now.
 * The on-chain user-min check uses secs from the actual open (≤ 600 s for quick), so a user-min computed from this
 * reference is never smaller than the program needs.
 */
export function pricingNowSecs(quick: boolean, expiry: number, now: number): number {
  return quick ? Math.max(now, expiry - QUICK_AUCTION_OPEN_OFFSET) : now;
}

export type EpochKind = "Std" | "Quick";
export interface KindParams { nBuckets: number; bucketSecs: number; bucketToleranceSecs: number; graceSecs: number; poolDelaySecs: number }
/** Plan A (bucketed median; notes/oracle.md: Plan A passed). Values come from packages/shared EPOCH_PARAMS (program mirror). */
export const KIND_PARAMS: Record<EpochKind, KindParams & { auctionSecsMin: number; auctionSecsMax: number }> = {
  Std: pick(EPOCH_PARAMS.Std),
  Quick: pick(EPOCH_PARAMS.Quick),
};
function pick(p: (typeof EPOCH_PARAMS)[EpochKind]) {
  return { nBuckets: p.nBuckets, bucketSecs: p.bucketSecs, bucketToleranceSecs: p.bucketToleranceSecs, graceSecs: p.graceSecs, poolDelaySecs: p.poolDelaySecs, auctionSecsMin: p.auctionSecsMin, auctionSecsMax: p.auctionSecsMax };
}
/** Std 300 s (decision 2026-10-06: 30–60 s is too short for real market makers; std rounds are batched in the 08:00–08:30 UTC window). Quick stays 30 s (60 s window). */
export const DEFAULT_AUCTION_SECS: Record<EpochKind, number> = { Std: 300, Quick: 30 };

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Next daily 08:00 UTC strictly after `now` (unix secs). */
export function nextDailyExpiry(now: number): number {
  const today = now - mod(now, DAY) + STD_EXPIRY_SECS_OF_DAY;
  return today > now ? today : today + DAY;
}
/** Next Friday 08:00 UTC strictly after `now`. (1970-01-01 was a Thursday ⇒ Friday = day index ≡ 1 mod 7.) */
export function nextFridayExpiry(now: number): number {
  let e = nextDailyExpiry(now);
  while (mod(Math.floor(e / DAY), 7) !== 1) e += DAY;
  return e;
}
/** Last Friday 08:00 UTC of the month containing `e`'s month, at or after now (Deribit monthly). */
export function nextMonthlyExpiry(now: number): number {
  const d = new Date(now * 1000);
  for (let m = 0; m < 3; m++) {
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + m;
    const lastDay = new Date(Date.UTC(y, mo + 1, 0, 8));
    while (lastDay.getUTCDay() !== 5) lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    const e = lastDay.getTime() / 1000;
    if (e > now) return e;
  }
  throw new Error("unreachable");
}
export function nextQuickExpiry(now: number): number {
  return now - mod(now, QUICK_PERIOD_SECS) + QUICK_PERIOD_SECS;
}

/** `open_epoch` schedule check (program mirror). */
export function isValidEpochExpiry(kind: EpochKind, expiry: number, now: number): boolean {
  if (expiry > now + MAX_EPOCH_AHEAD_SECS) return false;
  return kind === "Std" ? mod(expiry, DAY) === STD_EXPIRY_SECS_OF_DAY : mod(expiry, QUICK_PERIOD_SECS) === 0;
}

export function windowStart(kind: EpochKind, expiry: number): number {
  const p = KIND_PARAMS[kind];
  return expiry - p.nBuckets * p.bucketSecs;
}
export function bucketStart(kind: EpochKind, expiry: number, i: number): number {
  return windowStart(kind, expiry) + i * KIND_PARAMS[kind].bucketSecs;
}

/** Program mirror of the `open_round` time checks (OutsideAuctionWindow / ExpiryOutOfBounds). */
export function canOpenRound(kind: EpochKind, expiry: number, now: number, auctionSecs: number): { ok: boolean; reason?: string } {
  const p = KIND_PARAMS[kind];
  if (kind === "Std") {
    if (mod(now - STD_EXPIRY_SECS_OF_DAY, DAY) >= STD_AUCTION_WINDOW_SECS) return { ok: false, reason: "outside std auction window (08:00–08:30 UTC)" };
    if (expiry - now < STD_MIN_SECS_TO_EXPIRY) return { ok: false, reason: "std expiry < 12 h away" };
    if (!(now + auctionSecs + p.poolDelaySecs < windowStart(kind, expiry))) return { ok: false, reason: "auction would overlap sampling window" };
    return { ok: true };
  }
  if (now < expiry - QUICK_AUCTION_OPEN_OFFSET || now > expiry - QUICK_AUCTION_CLOSE_OFFSET) return { ok: false, reason: "outside quick auction window" };
  return { ok: true };
}

/** Is the std auction window open right now? */
export function stdWindowOpen(now: number): boolean {
  return mod(now - STD_EXPIRY_SECS_OF_DAY, DAY) < STD_AUCTION_WINDOW_SECS;
}

/** The Std expiries the keeper keeps open: next two dailies, the next four Fridays, and the monthly. */
export function stdEpochTargets(now: number): number[] {
  const set = new Set<number>();
  const d = nextDailyExpiry(now);
  set.add(d);
  set.add(d + DAY); // the expiry a round opened at the next 08:00 window would use
  const fri = nextFridayExpiry(now);
  for (let w = 0; w < 4; w++) set.add(fri + w * 7 * DAY); // weekly ladder (desk's 2–4 week band)
  set.add(nextMonthlyExpiry(now));
  return [...set].sort((a, b) => a - b);
}
/** Quick expiries to pre-open: the current one (if its auction window hasn't closed) and the next two. */
export function quickEpochTargets(now: number): number[] {
  const e = nextQuickExpiry(now);
  return [e, e + QUICK_PERIOD_SECS, e + 2 * QUICK_PERIOD_SECS];
}

/** Buckets whose start has passed and which are still postable (not filled, inside grace). */
export function dueBuckets(kind: EpochKind, expiry: number, sampleMask: number, now: number): number[] {
  const p = KIND_PARAMS[kind];
  if (now > expiry + p.graceSecs) return [];
  const out: number[] = [];
  for (let i = 0; i < p.nBuckets; i++) {
    if (sampleMask & (1 << i)) continue;
    if (bucketStart(kind, expiry, i) <= now) out.push(i);
  }
  return out;
}

export type ResolveAction = "wait" | "resolve" | "fail";
/** Program mirror of resolve_epoch's outcome. */
export function resolveAction(kind: EpochKind, expiry: number, filled: number, now: number): ResolveAction {
  const p = KIND_PARAMS[kind];
  if (filled >= p.nBuckets && now >= expiry) return "resolve";
  if (now >= expiry + p.graceSecs) return filled >= p.nBuckets - 2 ? "resolve" : "fail";
  return "wait";
}
export const popcount = (m: number) => { let c = 0; while (m) { c += m & 1; m >>>= 1; } return c; };
