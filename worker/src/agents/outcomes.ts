/**
 * Deterministic outcome statistics (replaces LLM reflection — see notes/agents.md). Pure functions over the rounds
 * mirror. Used by the desk's `recent_outcomes` tool and by each maker's own P&L history. No model is involved.
 */
import type { RoundRow } from "../db/types.js";

const TAKEN = new Set(["Live", "Resolved", "Settled", "Unwound"]);
const RESOLVED = new Set(["Resolved", "Settled"]);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const usd = (base: bigint | string | null | undefined) => (base === null || base === undefined ? null : Number(BigInt(base)) / 1e6);

/** Seconds from auction start to the take, inverted from the linear Dutch auction (exact up to the program's floor division). */
export function secondsToFill(r: Pick<RoundRow, "premium_start" | "premium_floor" | "premium_paid" | "auction_secs" | "is_pool">): number | null {
  if (r.is_pool || r.auction_secs === undefined || r.auction_secs === null) return null;
  const start = BigInt(r.premium_start), floor = BigInt(r.premium_floor), paid = BigInt(r.premium_paid || "0");
  if (paid <= 0n) return null;
  if (start <= floor) return 0;
  const e = (Number(start - paid) * r.auction_secs) / Number(start - floor);
  return Math.max(0, Math.min(r.auction_secs, Math.round(e)));
}

/** Option-holder (maker) value at settlement minus premium paid, USDC base units. Puts: (K − S)⁺·size; calls: (S − K)⁺·size. */
export function makerPnl(r: { kind: string; strike: bigint; size: bigint; settlePrice: bigint; exercised: boolean; premiumPaid: bigint }, assetDecimals: number): bigint {
  let value = 0n;
  if (r.exercised && r.settlePrice > 0n) {
    const diff = r.kind.toLowerCase() === "put" ? r.strike - r.settlePrice : r.settlePrice - r.strike;
    if (diff > 0n) value = (diff * r.size) / 10n ** BigInt(assetDecimals);
  }
  return value - r.premiumPaid;
}

export interface OutcomeStats {
  n_rounds: number;
  auctions_finished: number;
  taken: number;
  fill_rate: number | null;
  untaken: number;
  pool_takes: number;
  fill_price_over_start: { mean: number; min: number; max: number } | null;
  seconds_to_fill: { median: number; n: number } | null;
  resolved: number;
  exercised: number;
  exercise_rate: number | null;
  maker_wins: Record<string, number>;
  last_rounds: {
    auction_start: string; kind: string; strike_usd: number | null; start_usd: number | null; floor_usd: number | null; paid_usd: number | null;
    paid_over_start: number | null; seconds_to_fill: number | null; winner: string | null; status: string; exercised: boolean | null;
  }[];
}

export function outcomeStats(rows: RoundRow[], makerNames: Record<string, string> = {}, lastN = 5): OutcomeStats {
  const finished = rows.filter((r) => r.status !== "Auction");
  const taken = finished.filter((r) => TAKEN.has(r.status) && BigInt(r.premium_paid || "0") > 0n);
  const untaken = finished.filter((r) => r.status === "Cancelled");
  const ratios = taken.filter((r) => BigInt(r.premium_start) > 0n).map((r) => Number(BigInt(r.premium_paid)) / Number(BigInt(r.premium_start)));
  const secs = taken.map(secondsToFill).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const resolved = finished.filter((r) => RESOLVED.has(r.status));
  const exercised = resolved.filter((r) => r.exercised === 2);
  const wins: Record<string, number> = {};
  const winner = (r: RoundRow) => (r.is_pool ? "pool" : r.maker ? (makerNames[r.maker] ?? "other") : null);
  for (const r of taken) { const w = winner(r)!; wins[w] = (wins[w] ?? 0) + 1; }
  const median = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2]! : (secs[secs.length / 2 - 1]! + secs[secs.length / 2]!) / 2) : null;
  return {
    n_rounds: rows.length,
    auctions_finished: finished.length,
    taken: taken.length,
    fill_rate: finished.length ? r4(taken.length / finished.length) : null,
    untaken: untaken.length,
    pool_takes: taken.filter((r) => r.is_pool).length,
    fill_price_over_start: ratios.length ? { mean: r4(ratios.reduce((a, b) => a + b, 0) / ratios.length), min: r4(Math.min(...ratios)), max: r4(Math.max(...ratios)) } : null,
    seconds_to_fill: median === null ? null : { median, n: secs.length },
    resolved: resolved.length,
    exercised: exercised.length,
    exercise_rate: resolved.length ? r4(exercised.length / resolved.length) : null,
    maker_wins: wins,
    last_rounds: rows.slice(0, lastN).map((r) => {
      const t = TAKEN.has(r.status) && BigInt(r.premium_paid || "0") > 0n;
      return {
        auction_start: r.auction_start, kind: String(r.kind).toLowerCase(), strike_usd: usd(r.strike), start_usd: usd(r.premium_start), floor_usd: usd(r.premium_floor),
        paid_usd: t ? usd(r.premium_paid) : null, paid_over_start: t && BigInt(r.premium_start) > 0n ? r4(Number(BigInt(r.premium_paid)) / Number(BigInt(r.premium_start))) : null,
        seconds_to_fill: t ? secondsToFill(r) : null, winner: t ? winner(r) : null, status: r.status, exercised: RESOLVED.has(r.status) ? r.exercised === 2 : null,
      };
    }),
  };
}

/** What adaptation from these statistics may and may not change (shown to the Quant with the numbers). */
export const OUTCOMES_GUIDANCE = {
  may_inform: ["auction_secs", "expiry choice", "round size (ladder)", "skip"],
  never_changes: ["the user's signed limits (price range, size, deadline, minimum yield)", "the strike", "the premiums (they come from the price grid)", "settlement"],
  caveat: "Small samples. Quick rounds are mostly taken by Bide's own maker bots, so fill statistics partly reflect their strategies. Treat as weak evidence.",
};
