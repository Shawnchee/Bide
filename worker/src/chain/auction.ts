// Program mirrors (BUILD §3.3) — exact integer math so bots and the chain agree.
import * as S from "@bide/shared";
import type { RoundState } from "./types.js";

/** price = start − (start − floor) × clamp(now − auction_start, 0, secs) / secs (floor division, u128 on-chain). */
export function auctionPrice(r: Pick<RoundState, "premiumStart" | "premiumFloor" | "auctionStart" | "auctionSecs">, now: number): bigint {
  const secs = BigInt(Math.max(r.auctionSecs, 0));
  if (secs === 0n) return r.premiumFloor;
  let elapsed = BigInt(Math.max(0, now - r.auctionStart));
  if (elapsed > secs) elapsed = secs;
  return r.premiumStart - ((r.premiumStart - r.premiumFloor) * elapsed) / secs;
}
/** take_round allowed while now ≤ auction_start + auction_secs + pool_delay_secs. */
export const takeDeadline = (r: Pick<RoundState, "auctionStart" | "auctionSecs" | "poolDelaySecs">) => r.auctionStart + r.auctionSecs + r.poolDelaySecs;
/** pool_take_round allowed once now ≥ auction_start + auction_secs + pool_delay_secs. */
export const poolWindowStart = takeDeadline;
/** cancel_round by anyone after the pool window + 60 s. */
export const publicCancelAt = (r: Pick<RoundState, "auctionStart" | "auctionSecs" | "poolDelaySecs">) => takeDeadline(r) + 60;

/** `open_round` minimum-premium check (after fee) — exact program inequality, from packages/shared. */
export const premiumMeetsUserMin = S.premiumMeetsMin;
/** notional = strike × size / 10^decimals; `roundUp` for amounts the user must lock. */
export const notionalOf = (strike: bigint, size: bigint, decimals: number, roundUp = false) =>
  roundUp ? S.notionalCeil(strike, size, decimals) : S.notionalFloor(strike, size, decimals);
/** Median as in the program: sort, even count → mean of middle two (floor division). */
export function medianSamples(xs: bigint[]): bigint {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = s.length;
  if (n === 0) throw new Error("no samples");
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2n;
}
