// Maker bot decisions — pure. BUILD §4.2 / SPEC §10.
import { auctionPrice, takeDeadline } from "../chain/auction.js";
import type { RoundState } from "../chain/types.js";

export const SPREAD_MIN = 0.02;
export const SPREAD_MAX = 0.14;

export interface MakerProfile {
  name: string;
  /** Vol tilt: bot prices with IV × (1 + volTilt). Bot 1 slightly bearish on vol, bot 2 slightly bullish. */
  volTilt: number;
  /** Max open notional (USDC units) this bot will carry across Live rounds. */
  maxOpenNotional: bigint;
}
export const DEFAULT_PROFILES: MakerProfile[] = [
  { name: "maker-1", volTilt: -0.02, maxOpenNotional: 200_000_000n },
  { name: "maker-2", volTilt: 0.02, maxOpenNotional: 200_000_000n },
  { name: "maker-3", volTilt: 0.0, maxOpenNotional: 100_000_000n },
];

/** Uniform draw in [0.02, 0.14]. `rand` injectable for tests. */
export const drawSpread = (rand: () => number = Math.random) => SPREAD_MIN + (SPREAD_MAX - SPREAD_MIN) * rand();

/** bid = fair_at_tilted_vol × (1 − s), integer USDC units. */
export function makerBid(fairAtTiltedVol: number, spread: number): bigint {
  return BigInt(Math.max(0, Math.floor(fairAtTiltedVol * (1 - spread))));
}

export interface Inventory { usdc: bigint; asset: bigint; openNotional: bigint }

export type MakerDecision =
  | { act: "take"; price: bigint; bid: bigint }
  | { act: "wait"; price: bigint; bid: bigint }
  | { act: "skip"; reason: string };

/**
 * Take when auction_price(now) ≤ bid, inside the maker window, with enough inventory.
 * Puts: maker escrows `size` asset + pays premium in USDC. Calls: escrows `notional` USDC + premium.
 */
export function makerDecide(r: RoundState, bid: bigint, inv: Inventory, profile: MakerProfile, now: number): MakerDecision {
  if (r.status !== "Auction") return { act: "skip", reason: "not in auction" };
  if (now > takeDeadline(r)) return { act: "skip", reason: "maker window over" };
  if (bid < r.premiumFloor) return { act: "skip", reason: "bid below floor" };
  if (inv.openNotional + r.notional > profile.maxOpenNotional) return { act: "skip", reason: "inventory cap" };
  const price = auctionPrice(r, now);
  const needUsdc = price + (r.kind === "Call" ? r.notional : 0n);
  const needAsset = r.kind === "Put" ? r.size : 0n;
  if (inv.usdc < needUsdc) return { act: "skip", reason: "insufficient USDC" };
  if (inv.asset < needAsset) return { act: "skip", reason: "insufficient asset (WSOL)" };
  return price <= bid ? { act: "take", price, bid } : { act: "wait", price, bid };
}
