// Minimal local types mirroring BUILD §3.2 (accounts) and §7 (Supabase mirror).
// Switch to @bide/shared types once the P lane publishes them (see notes/frontend.md).
// u64 values are bigint on-chain; Supabase mirrors may deliver them as string | number.

export type PlanSide = "buy" | "sell" | "wheel";
export type PlanPhase = "accumulate" | "exit";
export type PlanStatus = "active" | "filled" | "closed";
export type RoundKind = "put" | "call";
export type RoundStatus = "auction" | "live" | "cancelled" | "resolved" | "settled" | "unwound";
export type EpochKind = "std" | "quick";
export type EpochStatus = "open" | "sampling" | "resolved" | "failed";
export type Patience = "patient" | "balanced" | "eager";

export type U64ish = string | number | bigint;

/** Supabase `plans` mirror row (BUILD §7). */
export interface PlanRow {
  plan_pubkey: string;
  owner: string;
  asset: string;
  side: PlanSide | string;
  phase: PlanPhase | string;
  quick: boolean;
  target_strike: U64ish;
  exit_strike: U64ish | null;
  size_total: U64ish;
  size_filled: U64ish;
  horizon_end: number | string;
  status: PlanStatus | string;
  updated_at: string;
  // Optional extras the keeper may mirror (requested in notes/frontend.md).
  paused?: boolean | null;
  collateral_principal?: U64ish | null;
  min_premium_bps_per_day?: number | null;
  create_sig?: string | null;
}

/** Supabase `rounds` mirror row (BUILD §7 + requested extras). */
export interface RoundRow {
  round_pubkey: string;
  plan_pubkey: string;
  strike: U64ish;
  size: U64ish;
  expiry: number | string;
  premium_paid: U64ish | null;
  maker: string | null;
  is_pool: boolean | null;
  status: RoundStatus | string;
  settle_price: U64ish | null;
  exercised: number | boolean | null;
  sigs: Record<string, string> | null;
  // Requested extras (notes/frontend.md): needed for /auctions and the plan page.
  kind?: RoundKind | string | null;
  fee_paid?: U64ish | null;
  premium_start?: U64ish | null;
  premium_floor?: U64ish | null;
  auction_start?: number | string | null;
  auction_secs?: number | null;
  epoch_pubkey?: string | null;
  /** Asset account pubkey (rounds.asset, agents migration). */
  asset?: string | null;
  memo_hash?: string | null;
  cex_fair_premium?: U64ish | null;
  created_at?: string | null;
}

/** Supabase `epochs` mirror row. */
export interface EpochRow {
  epoch_pubkey: string;
  asset: string;
  kind: EpochKind | string;
  expiry: number | string;
  samples: (U64ish | null)[] | { bucket: number; price: U64ish; publish_time?: number; sig?: string }[] | null;
  settle_price: U64ish | null;
  status: EpochStatus | string;
}

export interface DeskStep {
  step: string;
  at: number;
  detail: Record<string, unknown>;
}

/** Supabase `desk_runs` row (BUILD §7). Shapes of jsonb columns follow worker/src/desk/types.ts. */
export interface DeskRunRow {
  id: string;
  plan_pubkey: string | null;
  kind: "preview" | "round" | string;
  steps: DeskStep[] | null;
  proposal: Record<string, unknown> | null;
  verdict: Record<string, unknown> | null;
  final: { status?: string; proposal?: Record<string, unknown> | null; reason?: string } | null;
  memo: Record<string, unknown> | null;
  memo_hash: string | null;
  tx_sig: string | null;
  error_code: string | null;
  status: string | null;
  created_at: string;
  card?: Record<string, unknown> | null;
}

export interface QuoteRow {
  asset: string;
  ts: string;
  fair_iv: number | null;
  bid_iv: number | null;
  venues: unknown;
  quick_pricing: boolean | null;
}

/** Supabase `maker_bids` row (supabase/migrations/20261006090000_agents.sql). One per maker per round. */
export interface MakerBidRow {
  id: string;
  round_pubkey: string;
  plan_pubkey: string;
  maker: string; // "maker-1" | "maker-2"
  maker_pubkey: string;
  stance_id: string | null;
  source: "llm" | "fallback" | string;
  stance: "bid" | "pass" | string;
  spread_pct: number | null;
  fair_at_bid: U64ish | null;
  bid: U64ish | null;
  thesis: string | null;
  confidence: number | null;
  reason: string | null;
  bid_hash: string;
  took: boolean;
  tx_sig: string | null;
  pnl_usdc: U64ish | null;
  created_at: string;
}
