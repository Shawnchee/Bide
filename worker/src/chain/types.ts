// Domain view of on-chain state (BUILD §3.2). The IDL-backed client normalises Anchor's decoded
// accounts (BN, `{ auction: {} }` enums) into these plain types so keeper/maker logic stays pure.
import type { EpochKind } from "../keeper/schedule.js";

export type RoundStatus = "Auction" | "Live" | "Cancelled" | "Resolved" | "Settled" | "Unwound";
export type EpochStatus = "Open" | "Sampling" | "Resolved" | "Failed";
export type PlanStatus = "Active" | "Filled" | "Closed";
export type PlanSide = "Buy" | "Sell" | "Wheel";
export type PlanPhase = "Accumulate" | "Exit";
export type RoundKind = "Put" | "Call";

export interface ConfigState { admin: string; agent: string; paused: boolean; feeBps: number; feeRecipient: string }
export interface AssetState {
  pubkey: string; mint: string; decimals: number; pythFeedId: string; strikeTick: bigint;
  maxConfBps: number; maxSpotMoveBps: number; maxSpotAgeSecs: number; enabled: boolean;
  /** Pricer symbol for this asset (derived from the feed id). */
  symbol: "SOL" | "BTC";
}
export interface PlanState {
  pubkey: string; owner: string; asset: string; side: PlanSide; phase: PlanPhase; quick: boolean;
  targetStrike: bigint; exitStrike: bigint; strikeMin: bigint; strikeMax: bigint; callStrikeMin: bigint; callStrikeMax: bigint;
  lockStrike: boolean; sizeTotal: bigint; sizeFilled: bigint; collateralPrincipal: bigint; lendShares: bigint;
  pendingSettlement: string | null; minPremiumBpsPerDay: number; maxExpirySecs: number; horizonEnd: number;
  maxRoundsPerDay: number; roundsToday: number; dayIndex: number; roundCount: number;
  activeRound: string | null; paused: boolean; status: PlanStatus;
}
export interface RoundState {
  pubkey: string; plan: string; asset: string; kind: RoundKind; strike: bigint; size: bigint; notional: bigint;
  epoch: string; expiry: number; auctionStart: number; auctionSecs: number; poolDelaySecs: number; rentPayer: string;
  premiumStart: bigint; premiumFloor: bigint; spotAtOpen: bigint; maker: string | null; makerIsPool: boolean;
  premiumPaid: bigint; feePaid: bigint; exercised: 0 | 1 | 2; settlePrice: bigint; memoHash: string; status: RoundStatus;
}
export interface EpochState {
  pubkey: string; asset: string; kind: EpochKind; expiry: number; nBuckets: number; bucketSecs: number; bucketToleranceSecs: number;
  samples: bigint[]; sampleMask: number; settlePrice: bigint; status: EpochStatus;
}
export interface PoolState {
  pubkey: string; paused: boolean; maxPremiumBpsOfNotional: number; maxOpenNotional: bigint; maxUtilizationBps: number;
  spendWindowSecs: number; spendWindowStart: number; spendWindowCap: bigint; spendWindowSpent: bigint;
  lendShares: bigint; reservedUsdc: bigint; reservedWsol: bigint; openNotional: bigint;
  /** Vault balances (read from the token accounts, not the Pool account). */
  usdcVault: bigint; wsolVault: bigint;
}

export interface ChainSnapshot {
  now: number; // unix secs (cluster time preferred)
  config: ConfigState;
  assets: AssetState[];
  plans: PlanState[];
  rounds: RoundState[];
  epochs: EpochState[];
  pool: PoolState | null;
}
