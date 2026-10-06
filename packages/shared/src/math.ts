// Mirrors programs/bide/src/math.rs (bigint, exact).
import { BPS } from "./constants.js";

const p10 = (d: number) => 10n ** BigInt(d);
export const notionalFloor = (strike: bigint, size: bigint, decimals: number) => (strike * size) / p10(decimals);
export const notionalCeil = (strike: bigint, size: bigint, decimals: number) => {
  const n = strike * size;
  const d = p10(decimals);
  return (n + d - 1n) / d;
};

export function auctionPrice(start: bigint, floor: bigint, auctionStart: number, auctionSecs: number, now: number): bigint {
  if (auctionSecs === 0) return floor;
  const elapsed = BigInt(Math.min(Math.max(now - auctionStart, 0), auctionSecs));
  return start - ((start - floor) * elapsed) / BigInt(auctionSecs);
}

/** User minimum check, after fee — same inequality as open_round. */
export function premiumMeetsMin(floor: bigint, feeBps: number, notional: bigint, minBpsPerDay: number, secsToExpiry: number): boolean {
  const lhs = floor * BigInt(BPS - feeBps) * 86_400n;
  const rhs = notional * BigInt(minBpsPerDay) * BigInt(Math.max(0, secsToExpiry));
  return lhs >= rhs;
}

/** Smallest premium_floor that passes PremiumBelowUserMin. */
export function minPremiumFloor(feeBps: number, notional: bigint, minBpsPerDay: number, secsToExpiry: number): bigint {
  const rhs = notional * BigInt(minBpsPerDay) * BigInt(Math.max(0, secsToExpiry));
  const den = BigInt(BPS - feeBps) * 86_400n;
  return (rhs + den - 1n) / den;
}

export const feeOf = (premium: bigint, feeBps: number) => (premium * BigInt(feeBps)) / BigInt(BPS);

/** Pyth (price, expo) → USDC base units */
export function pythToUsdc(price: bigint, expo: number): bigint {
  const e = 6 + expo;
  return e >= 0 ? price * 10n ** BigInt(e) : price / 10n ** BigInt(-e);
}

export function median(values: bigint[]): bigint {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const k = s.length;
  if (k === 0) throw new Error("no samples");
  return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2n;
}
