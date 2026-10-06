// Chain state → mirror rows.
import type { EpochState, PlanState, RoundState } from "../chain/types.js";
import type { EpochRow, PlanRow, RoundRow } from "./types.js";

const ts = (secs: number) => new Date(secs * 1000).toISOString();
export const planRow = (p: PlanState): PlanRow => ({
  plan_pubkey: p.pubkey, owner: p.owner, asset: p.asset, side: p.side, phase: p.phase, quick: p.quick,
  target_strike: p.targetStrike.toString(), exit_strike: p.exitStrike.toString(), size_total: p.sizeTotal.toString(), size_filled: p.sizeFilled.toString(),
  horizon_end: ts(p.horizonEnd), status: p.status,
});
export const roundRow = (r: RoundState): RoundRow => ({
  round_pubkey: r.pubkey, plan_pubkey: r.plan, kind: r.kind, strike: r.strike.toString(), size: r.size.toString(), notional: r.notional.toString(),
  expiry: ts(r.expiry), auction_start: ts(r.auctionStart), premium_start: r.premiumStart.toString(), premium_floor: r.premiumFloor.toString(),
  premium_paid: r.premiumPaid.toString(), fee_paid: r.feePaid.toString(), maker: r.makerIsPool ? "pool" : r.maker, is_pool: r.makerIsPool,
  status: r.status, settle_price: r.settlePrice > 0n ? r.settlePrice.toString() : null, exercised: r.exercised, memo_hash: r.memoHash,
  asset: r.asset, auction_secs: r.auctionSecs, pool_delay_secs: r.poolDelaySecs,
});
export const epochRow = (e: EpochState): EpochRow => ({
  epoch_pubkey: e.pubkey, asset: e.asset, kind: e.kind, expiry: ts(e.expiry), samples: e.samples.map(String), sample_mask: e.sampleMask,
  settle_price: e.settlePrice > 0n ? e.settlePrice.toString() : null, status: e.status,
});
