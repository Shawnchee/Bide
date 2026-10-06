// Mirrors plans/rounds/epochs to the DB and logs plan events derived from state transitions.
// Round accounts are CLOSED on Cancelled / not-exercised / Settled / Unwound, so a vanished round's final
// status is inferred from its last known state (and the epoch).
import type { SnapshotCache } from "../chain/snapshot-cache.js";
import type { ChainSnapshot, RoundState } from "../chain/types.js";
import { epochRow, planRow, roundRow, type Repo } from "../db/index.js";
import { logger } from "../log.js";

const log = logger("mirror");

/** Plan lifecycle events derived from consecutive snapshots (logged; no external notifications). */
export type PlanEvent =
  | { type: "RoundTaken"; plan: string; owner: string; round: string; premiumUsdc: number; feeUsdc: number; isPool: boolean }
  | { type: "RoundResolved"; plan: string; owner: string; round: string; exercised: boolean; settlePriceUsd: number; strikeUsd: number }
  | { type: "PlanFlipped"; plan: string; owner: string }
  | { type: "PlanExpired"; plan: string; owner: string };

/**
 * Exercise rule, same as resolve_round (programs/bide settle.rs): put iff settle < strike, call iff settle > strike.
 * Used when a Live round vanishes between mirror ticks on a Resolved epoch (the keeper can resolve + settle/withdraw
 * inside one 15 s interval), so we never observed its Resolved state and must not guess "not exercised" (W-M1).
 */
export function exercisedAtSettle(kind: string, strike: bigint, settlePrice: bigint): boolean {
  if (typeof strike !== "bigint" || typeof settlePrice !== "bigint" || settlePrice <= 0n) return false;
  return kind.toLowerCase() === "put" ? settlePrice < strike : settlePrice > strike;
}

/** For a Live round that vanished: if its epoch is Resolved, the derived outcome; otherwise null. */
export function vanishedLiveOutcome(last: RoundState, s: ChainSnapshot): { exercised: boolean; settlePrice: bigint } | null {
  const ep = s.epochs.find((e) => e.pubkey === last.epoch);
  if (ep?.status !== "Resolved") return null;
  return { exercised: exercisedAtSettle(last.kind, last.strike, ep.settlePrice), settlePrice: ep.settlePrice };
}

export function inferClosedStatus(last: RoundState, s: ChainSnapshot): RoundState["status"] {
  const ep = s.epochs.find((e) => e.pubkey === last.epoch);
  if (last.status === "Auction") return "Cancelled";
  if (last.status === "Resolved") return "Settled";
  if (last.status === "Live") return ep?.status === "Failed" ? "Unwound" : "Resolved";
  return last.status;
}

export function transitions(prev: ChainSnapshot | null, next: ChainSnapshot): PlanEvent[] {
  if (!prev) return [];
  const out: PlanEvent[] = [];
  const prevRounds = new Map(prev.rounds.map((r) => [r.pubkey, r]));
  const nextRounds = new Map(next.rounds.map((r) => [r.pubkey, r]));
  const owner = (plan: string) => next.plans.find((p) => p.pubkey === plan)?.owner ?? prev.plans.find((p) => p.pubkey === plan)?.owner ?? "";
  for (const r of next.rounds) {
    const p = prevRounds.get(r.pubkey);
    if (p?.status === "Auction" && r.status === "Live") {
      out.push({ type: "RoundTaken", plan: r.plan, owner: owner(r.plan), round: r.pubkey, premiumUsdc: Number(r.premiumPaid - r.feePaid) / 1e6, feeUsdc: Number(r.feePaid) / 1e6, isPool: r.makerIsPool });
    }
    if (p?.status === "Live" && r.status === "Resolved") {
      out.push({ type: "RoundResolved", plan: r.plan, owner: owner(r.plan), round: r.pubkey, exercised: r.exercised === 2, settlePriceUsd: Number(r.settlePrice) / 1e6, strikeUsd: Number(r.strike) / 1e6 });
    }
  }
  for (const p of prev.rounds) {
    if (nextRounds.has(p.pubkey) || p.status !== "Live") continue;
    const o = vanishedLiveOutcome(p, next);
    if (o) out.push({ type: "RoundResolved", plan: p.plan, owner: owner(p.plan), round: p.pubkey, exercised: o.exercised, settlePriceUsd: Number(o.settlePrice) / 1e6, strikeUsd: Number(p.strike) / 1e6 });
  }
  const prevPlans = new Map(prev.plans.map((p) => [p.pubkey, p]));
  for (const pl of next.plans) {
    const p = prevPlans.get(pl.pubkey);
    if (p?.phase === "Accumulate" && pl.phase === "Exit") out.push({ type: "PlanFlipped", plan: pl.pubkey, owner: pl.owner });
    if (p && p.status !== "Closed" && pl.status === "Closed" && next.now >= pl.horizonEnd) out.push({ type: "PlanExpired", plan: pl.pubkey, owner: pl.owner });
  }
  return out;
}

/** A maker-taken round whose settlement is now known (for the maker P&L ledger). */
export interface RoundOutcome { round: RoundState; exercised: boolean; settlePrice: bigint; assetDecimals: number }

/** Rounds taken by a maker (not the pool) that just resolved: Live → Resolved, or a Live round that vanished on a Resolved epoch (exercise derived from settle vs strike). */
export function roundOutcomes(prev: ChainSnapshot | null, next: ChainSnapshot): RoundOutcome[] {
  if (!prev) return [];
  const out: RoundOutcome[] = [];
  const dec = (asset: string) => next.assets.find((a) => a.pubkey === asset)?.decimals ?? prev.assets.find((a) => a.pubkey === asset)?.decimals ?? 9;
  const prevRounds = new Map(prev.rounds.map((r) => [r.pubkey, r]));
  const nextRounds = new Set(next.rounds.map((r) => r.pubkey));
  for (const r of next.rounds) {
    const p = prevRounds.get(r.pubkey);
    if (p?.status === "Live" && r.status === "Resolved" && r.maker && !r.makerIsPool) out.push({ round: r, exercised: r.exercised === 2, settlePrice: r.settlePrice, assetDecimals: dec(r.asset) });
  }
  for (const p of prev.rounds) {
    if (nextRounds.has(p.pubkey) || p.status !== "Live" || !p.maker || p.makerIsPool) continue;
    const o = vanishedLiveOutcome(p, next);
    if (o) out.push({ round: p, exercised: o.exercised, settlePrice: o.settlePrice, assetDecimals: dec(p.asset) });
  }
  return out;
}

export class Mirror {
  private prev: ChainSnapshot | null = null;
  constructor(private snapshots: SnapshotCache, private repo: Repo, private onOutcome?: (o: RoundOutcome) => Promise<void>) {}
  async tick() {
    const s = await this.snapshots.get();
    if (!s) return;
    const closed: RoundState[] = [];
    if (this.prev) {
      const live = new Set(s.rounds.map((r) => r.pubkey));
      for (const r of this.prev.rounds) {
        if (live.has(r.pubkey) || ["Cancelled", "Settled", "Unwound"].includes(r.status)) continue;
        const row: RoundState = { ...r, status: inferClosedStatus(r, s) };
        // A Live round that vanished on a Resolved epoch: record the derived exercise + settle price (2 = yes, 1 = no).
        const o = r.status === "Live" ? vanishedLiveOutcome(r, s) : null;
        if (o) { row.exercised = o.exercised ? 2 : 1; row.settlePrice = o.settlePrice; }
        closed.push(row);
      }
    }
    await this.repo.upsertPlans(s.plans.map(planRow));
    await this.repo.upsertRounds([...s.rounds, ...closed].map(roundRow));
    await this.repo.upsertEpochs(s.epochs.map(epochRow));
    for (const e of transitions(this.prev, s)) log.info("event", { type: e.type, plan: e.plan });
    if (this.onOutcome) for (const o of roundOutcomes(this.prev, s)) await this.onOutcome(o).catch((err) => log.warn("outcome hook failed", { round: o.round.pubkey, err: (err as Error).message }));
    this.prev = s;
  }
}
