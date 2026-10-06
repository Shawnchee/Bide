// Keeper decisions as a pure function of (chain snapshot, now). keeper/index.ts executes them.
import { notionalOf, poolWindowStart } from "../chain/auction.js";
import type { ChainSnapshot, PlanState, PoolState, RoundState } from "../chain/types.js";
import {
  bucketStart, canOpenRound, DEFAULT_AUCTION_SECS, dueBuckets, isValidEpochExpiry, popcount, quickEpochTargets,
  resolveAction, stdEpochTargets, stdWindowOpen, KIND_PARAMS, nextQuickExpiry, type EpochKind,
} from "./schedule.js";

export type KeeperAction =
  | { type: "open_epoch"; asset: string; kind: EpochKind; expiry: number }
  | { type: "pool_take_round"; round: string }
  | { type: "cancel_round"; round: string; reason: string }
  | { type: "post_sample"; epoch: string; asset: string; bucket: number; publishTime: number }
  | { type: "resolve_epoch"; epoch: string; expect: "resolve" | "fail" }
  | { type: "resolve_round"; round: string }
  | { type: "withdraw_collateral"; round: string }
  | { type: "unwind_round"; round: string }
  | { type: "expire_plan"; plan: string }
  | { type: "desk_flip"; plan: string }
  | { type: "desk_open_round"; plan: string; kind: EpochKind };

export interface KeeperOpts {
  quickEnabled: boolean;
  /** Epoch pubkey derivation for open_epoch dedupe: (asset, kind, expiry) → pubkey. */
  epochKey: (asset: string, kind: EpochKind, expiry: number) => string;
}

/** Can the pool legally take this round right now (mirror of pool_take_round's cap checks)? */
export function poolCanTake(pool: PoolState | null, r: RoundState, assetDecimals: number, now: number): { ok: boolean; reason?: string } {
  if (!pool) return { ok: false, reason: "no pool" };
  if (pool.paused) return { ok: false, reason: "pool paused" };
  if (r.premiumFloor * 10_000n > r.notional * BigInt(pool.maxPremiumBpsOfNotional)) return { ok: false, reason: "floor above pool max premium bps" };
  if (pool.openNotional + r.notional > pool.maxOpenNotional) return { ok: false, reason: "open-notional cap" };
  const windowReset = now >= pool.spendWindowStart + pool.spendWindowSecs;
  const spent = windowReset ? 0n : pool.spendWindowSpent;
  if (spent + r.premiumFloor > pool.spendWindowCap) return { ok: false, reason: "spend-window cap" };
  // Escrow: puts need `size` WSOL; calls need `notional` USDC. Premium always USDC.
  const needUsdc = r.premiumFloor + (r.kind === "Call" ? r.notional : 0n);
  const needWsol = r.kind === "Put" ? r.size : 0n;
  if (pool.usdcVault - pool.reservedUsdc < needUsdc) return { ok: false, reason: "insufficient free USDC" };
  if (pool.wsolVault - pool.reservedWsol < needWsol) return { ok: false, reason: "insufficient free WSOL" };
  // max_utilization_bps is NAV-based on-chain (needs Lend rate + spot); the program is the final check.
  void assetDecimals;
  return { ok: true };
}

export function planKeeperActions(s: ChainSnapshot, now: number, opts: KeeperOpts): KeeperAction[] {
  const out: KeeperAction[] = [];
  const epochsByPk = new Map(s.epochs.map((e) => [e.pubkey, e]));
  const assetsByPk = new Map(s.assets.map((a) => [a.pubkey, a]));
  const roundsByEpoch = new Map<string, RoundState[]>();
  for (const r of s.rounds) roundsByEpoch.set(r.epoch, [...(roundsByEpoch.get(r.epoch) ?? []), r]);

  // 1. open_epoch on schedule (only if missing). Quick epochs only while an active quick plan on that asset
  //    could use them (each empty quick epoch is rent the keeper never gets back).
  for (const a of s.assets.filter((x) => x.enabled)) {
    const kinds: [EpochKind, number[]][] = [["Std", stdEpochTargets(now)]];
    if (opts.quickEnabled && hasActiveQuickPlan(s, a.pubkey, now)) kinds.push(["Quick", quickEpochTargets(now)]);
    for (const [kind, expiries] of kinds) for (const expiry of expiries) {
      if (!isValidEpochExpiry(kind, expiry, now)) continue;
      if (!epochsByPk.has(opts.epochKey(a.pubkey, kind, expiry))) out.push({ type: "open_epoch", asset: a.pubkey, kind, expiry });
    }
  }

  // 2. Untaken auctions past the pool window → pool_take_round if caps allow, else cancel.
  for (const r of s.rounds.filter((x) => x.status === "Auction")) {
    if (now < poolWindowStart(r)) continue;
    const dec = assetsByPk.get(r.asset)?.decimals ?? 9;
    const can = poolCanTake(s.pool, r, dec, now);
    out.push(can.ok ? { type: "pool_take_round", round: r.pubkey } : { type: "cancel_round", round: r.pubkey, reason: can.reason! });
  }

  // 3–4. Epoch sampling / resolution, only for epochs that carry rounds (empty epochs just lapse — saves SOL).
  for (const e of s.epochs) {
    const rounds = roundsByEpoch.get(e.pubkey) ?? [];
    const live = rounds.filter((r) => r.status === "Live");
    if (e.status === "Open" || e.status === "Sampling") {
      if (live.length === 0) continue;
      for (const b of dueBuckets(e.kind, e.expiry, e.sampleMask, now)) {
        out.push({ type: "post_sample", epoch: e.pubkey, asset: e.asset, bucket: b, publishTime: bucketStart(e.kind, e.expiry, b) });
      }
      const act = resolveAction(e.kind, e.expiry, popcount(e.sampleMask), now);
      if (act !== "wait") out.push({ type: "resolve_epoch", epoch: e.pubkey, expect: act });
    } else if (e.status === "Resolved") {
      for (const r of live) out.push({ type: "resolve_round", round: r.pubkey });
    } else if (e.status === "Failed") {
      for (const r of live) out.push({ type: "unwind_round", round: r.pubkey });
    }
  }
  // Exercised rounds awaiting collateral withdrawal (retryable).
  for (const r of s.rounds) if (r.status === "Resolved" && r.exercised === 2) out.push({ type: "withdraw_collateral", round: r.pubkey });

  // 5–7. Plan lifecycle.
  if (!s.config.paused) for (const p of s.plans) {
    if (p.status !== "Active") continue;
    const idle = !p.activeRound && !p.pendingSettlement;
    if (now >= p.horizonEnd) { if (idle) out.push({ type: "expire_plan", plan: p.pubkey }); continue; }
    if (p.side === "Wheel" && p.phase === "Accumulate" && p.sizeFilled >= p.sizeTotal && p.sizeTotal > 0n) {
      if (idle) out.push({ type: "desk_flip", plan: p.pubkey });
      continue;
    }
    if (!idle || p.paused || p.sizeFilled >= p.sizeTotal) continue;
    const kind: EpochKind = p.quick ? "Quick" : "Std";
    if (kind === "Quick" && !opts.quickEnabled) continue;
    if (!inAuctionWindow(kind, now)) continue;
    out.push({ type: "desk_open_round", plan: p.pubkey, kind });
  }
  return out;
}

/** An Active, unpaused, unfilled quick plan on `asset` whose horizon has not ended. */
export function hasActiveQuickPlan(s: ChainSnapshot, asset: string, now: number): boolean {
  return s.plans.some((p) => p.quick && p.asset === asset && p.status === "Active" && !p.paused && p.sizeFilled < p.sizeTotal && now < p.horizonEnd);
}

/** Quick desk runs start this many seconds before the 60 s auction window (LLM latency), result held until it opens. */
export const QUICK_DESK_LEAD_SECS = 90;

/** The quick epoch whose [expiry − 600 − lead, expiry − 540] desk window contains `now`, if any. */
export function quickTargetExpiry(now: number, lead = QUICK_DESK_LEAD_SECS): number | null {
  for (const e of [nextQuickExpiry(now), nextQuickExpiry(now) + 600]) if (now >= e - 600 - lead && now <= e - 540) return e;
  return null;
}

/** Should the desk run now? Std: 08:00–08:30 UTC. Quick: from 90 s before until the end of the 60 s auction window. */
export function inAuctionWindow(kind: EpochKind, now: number): boolean {
  if (kind === "Std") return stdWindowOpen(now);
  return quickTargetExpiry(now) !== null;
}

/**
 * Epoch expiries a desk proposal may legally target for this plan right now (program mirror):
 * Quick → the open quick epoch; Std → next dailies, the next four Fridays, and the monthly,
 * filtered by the auction-window rules and min(now + max_expiry_secs, horizon_end).
 */
export function eligibleExpiries(p: Pick<PlanState, "quick" | "maxExpirySecs" | "horizonEnd">, now: number): number[] {
  const kind: EpochKind = p.quick ? "Quick" : "Std";
  const limit = Math.min(now + p.maxExpirySecs, p.horizonEnd);
  if (kind === "Quick") {
    // Desk may run up to QUICK_DESK_LEAD_SECS early: eligibility is judged at the window's opening second.
    const e = quickTargetExpiry(now);
    return e !== null && e <= Math.min(e - 600 + p.maxExpirySecs, p.horizonEnd) ? [e] : [];
  }
  return [...new Set(stdEpochTargets(now))].filter((e) => e <= limit && canOpenRound(kind, e, now, DEFAULT_AUCTION_SECS[kind]).ok).sort((a, b) => a - b);
}

export { notionalOf, KIND_PARAMS };
