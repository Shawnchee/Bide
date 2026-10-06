// BUILD §3.3 auction formula, mirrored exactly (u128 math → bigint).
export function auctionPrice(p: { premiumStart: bigint; premiumFloor: bigint; auctionStart: number; auctionSecs: number }, now: number): bigint {
  const secs = Math.max(1, p.auctionSecs);
  const elapsed = BigInt(Math.min(Math.max(now - p.auctionStart, 0), secs));
  return p.premiumStart - ((p.premiumStart - p.premiumFloor) * elapsed) / BigInt(secs);
}

export type AuctionPhase = "falling" | "floor" | "pool" | "over";

export function auctionPhase(p: { auctionStart: number; auctionSecs: number; poolDelaySecs: number }, now: number): AuctionPhase {
  const end = p.auctionStart + p.auctionSecs;
  if (now < end) return "falling";
  if (now <= end + p.poolDelaySecs) return "floor";
  // After the pool window opens, take_round is no longer allowed (BUILD §3.3 #6).
  return now <= end + p.poolDelaySecs + 60 ? "pool" : "over";
}
