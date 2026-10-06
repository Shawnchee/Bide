// TS mirrors of the on-chain accounts, enums, args, events, errors — derived from the generated IDL
// so they can never drift. Anchor TS decodes enums as `{ buy: {} }` objects; helpers below convert.
import type { IdlAccounts, IdlTypes, IdlEvents } from "@anchor-lang/core";
import type { Bide } from "./idl/bide.js";

export type { Bide };
export type ConfigAccount = IdlAccounts<Bide>["config"];
export type AssetAccount = IdlAccounts<Bide>["asset"];
export type PlanAccount = IdlAccounts<Bide>["plan"];
export type RoundAccount = IdlAccounts<Bide>["round"];
export type EpochAccount = IdlAccounts<Bide>["epoch"];
export type PoolAccount = IdlAccounts<Bide>["pool"];

export type CreatePlanArgs = IdlTypes<Bide>["createPlanArgs"];
export type OpenRoundArgs = IdlTypes<Bide>["openRoundArgs"];
export type UpdatePlanArgs = IdlTypes<Bide>["updatePlanArgs"];
export type AssetParams = IdlTypes<Bide>["assetParams"];
export type PoolParams = IdlTypes<Bide>["poolParams"];

export type BideEvents = IdlEvents<Bide>;

// ---- enums (variant order == on-chain u8 discriminant) ----
export const SIDES = ["buy", "sell", "wheel"] as const;
export type SideName = (typeof SIDES)[number];
export const PHASES = ["accumulate", "exit"] as const;
export const PLAN_STATUSES = ["active", "filled", "closed"] as const;
export const ROUND_KINDS = ["put", "call"] as const;
export const ROUND_STATUSES = ["auction", "live", "cancelled", "resolved", "settled", "unwound"] as const;
export type RoundStatusName = (typeof ROUND_STATUSES)[number];
export const EPOCH_KINDS = ["std", "quick"] as const;
export type EpochKindName = (typeof EPOCH_KINDS)[number];
export const EPOCH_STATUSES = ["open", "sampling", "resolved", "failed"] as const;
export const EXERCISED = { unknown: 0, no: 1, yes: 2 } as const;

/** `{ buy: {} }` → "buy" */
export function enumName<T extends string>(v: Record<string, unknown>): T {
  return Object.keys(v)[0] as T;
}
/** "buy" → `{ buy: {} }` (for instruction args) */
export function enumArg<T extends string>(name: T): Record<T, Record<string, never>> {
  return { [name]: {} } as Record<T, Record<string, never>>;
}

/** Byte offset of Round.status in account data (for getProgramAccounts memcmp). */
// discriminator 8 + plan 32 + asset 32 + round_index 4 + kind 1 + strike 8 + size 8 + notional 8 + epoch 32
// + expiry 8 + auction_start 8 + auction_secs 4 + pool_delay_secs 4 + rent_payer 32 + premium_start 8
// + premium_floor 8 + spot_at_open 8 + maker 32 + maker_is_pool 1 + premium_paid 8 + fee_paid 8
// + exercised 1 + settle_price 8 + memo_hash 32
export const ROUND_STATUS_OFFSET = 8 + 32 + 32 + 4 + 1 + 8 + 8 + 8 + 32 + 8 + 8 + 4 + 4 + 32 + 8 + 8 + 8 + 32 + 1 + 8 + 8 + 1 + 8 + 32;
/** Byte offset of Round.plan (memcmp by plan). */
export const ROUND_PLAN_OFFSET = 8;
/** Byte offset of Plan.owner (memcmp by owner). */
export const PLAN_OWNER_OFFSET = 8;

// ---- errors (BUILD §3.4 + additions), code = 6000 + index ----
export const BIDE_ERRORS = [
  "EpochNotOpen", "OutsideAuctionWindow", "EpochNotResolved", "GraceNotElapsed", "PlanNotExpired", "Paused",
  "PlanPaused", "AssetDisabled", "StrikeOutOfBounds", "StrikeOffTick", "SizeTooLarge", "ExpiryOutOfBounds",
  "RateLimited", "PremiumBelowUserMin", "AuctionParamsInvalid", "ActiveRoundExists", "WrongStatus", "AuctionOver",
  "PoolWindowNotReached", "SpotMovedTooMuch", "StalePrice", "PriceConfidenceTooWide", "WrongFeed",
  "BucketOutOfRange", "BucketFilled", "SampleOutsideBucket", "NotEnoughSamples", "NotExpired", "PoolCapExceeded",
  "MathOverflow", "Unauthorized", "FeeTooHigh", "InvalidSchedule", "HorizonOutOfRange", "PoolPaused",
  "InsufficientFreeFunds", "InvalidMint", "ZeroAmount", "EpochFailed", "SettlementPending", "EpochKindMismatch",
  "NotWheelPlan", "WrongPhase", "InvalidAccount", "InvalidLendAccounts", "NotFullyVerified", "InvalidPlanParams",
  "NotImplemented", "RoundTooSmall",
] as const;
export type BideErrorName = (typeof BIDE_ERRORS)[number];
export const BIDE_ERROR_BASE = 6000;
export function bideErrorName(code: number): BideErrorName | null {
  const i = code - BIDE_ERROR_BASE;
  return i >= 0 && i < BIDE_ERRORS.length ? BIDE_ERRORS[i] : null;
}
/** Extract a Bide error name from logs / an error message ("custom program error: 0x1770"). */
export function parseBideError(err: unknown): BideErrorName | null {
  const s = String((err as { message?: string })?.message ?? err) + " " + ((err as { logs?: string[] })?.logs ?? []).join("\n");
  const m = s.match(/Error Code: (\w+)/);
  if (m && (BIDE_ERRORS as readonly string[]).includes(m[1])) return m[1] as BideErrorName;
  const h = s.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (h) return bideErrorName(parseInt(h[1], 16));
  return null;
}

export const EVENT_NAMES = [
  "PlanCreated", "RoundOpened", "RoundTaken", "EpochOpened", "SamplePosted", "EpochResolved", "EpochFailed",
  "RoundResolved", "CollateralWithdrawn", "RoundCancelled", "RoundUnwound", "PlanUpdated", "PlanFlipped",
  "PlanClosed", "PlanExpired", "PoolDeposited", "PoolWithdrawn",
] as const;
