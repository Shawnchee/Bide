/**
 * Agent desk — public types.
 *
 * W lane: `worker/src/desk-api.ts` did not exist when this was written, so the desk defines its
 * own contract here (see notes/desk.md). Wire to it with:
 *   const desk = createDesk({ tools, transport, risk });   // see orchestrator.ts
 *   const result = await desk.runDesk(input);              // runDesk(input) => Promise<DeskResult>
 *   const again  = await desk.retryWithChainError(result, "StrikeOutOfBounds");
 *
 * Units follow BUILD §3.1. Every u64 travels as a base-10 digit string (no floats, no JS number
 * overflow). Unix timestamps (i64 seconds) travel as JS integers (safe until year 285 million).
 *   - strike / premiums / notional: USDC base units (6 decimals). $110 → "110000000".
 *   - size: asset base units (SOL 9, tBTC 8). 0.2 SOL → "200000000".
 *   - expiry: unix seconds of the Epoch expiry (Std: 08:00 UTC; Quick: multiple of 600).
 */

export type U64 = string; // decimal digits only, 0 ≤ v < 2^64

export type PlanSide = "buy" | "sell" | "wheel";
export type PlanPhase = "accumulate" | "exit";
export type RoundKind = "put" | "call";
export type EpochKind = "std" | "quick";
export type Patience = "patient" | "balanced" | "eager";

// ---------------------------------------------------------------------------------------------
// Tool results — produced by W's implementation of `DeskTools` (pricer + RPC). Core fields are
// typed because the desk reads them (risk state, card, enrichment); extra fields pass through.
// ---------------------------------------------------------------------------------------------

/** get_plan — on-chain Plan account + Config.fee_bps + open epochs (all, NOT filtered by plan bounds). */
export interface PlanView {
  plan_id: string;
  owner: string;
  asset: string; // "SOL" | "BTC"
  asset_mint: string;
  asset_decimals: number;
  side: PlanSide;
  phase: PlanPhase;
  quick: boolean;
  target_strike: U64;
  exit_strike: U64;
  lock_strike: boolean;
  strike_min: U64;
  strike_max: U64;
  call_strike_min: U64;
  call_strike_max: U64;
  strike_tick: U64;
  size_total: U64;
  size_filled: U64;
  collateral_principal: U64;
  min_premium_bps_per_day: number;
  max_expiry_secs: number;
  horizon_end: number;
  max_rounds_per_day: number;
  rounds_today: number;
  paused: boolean;
  status: "active" | "filled" | "closed";
  active_round: string | null;
  pending_settlement: string | null;
  /** Config.fee_bps (platform fee on every premium). */
  fee_bps: number;
  /** Epochs currently open on-chain for this asset (both kinds). Not filtered by plan bounds. */
  open_epochs: { expiry: number; kind: EpochKind; pubkey?: string }[];
  [extra: string]: unknown;
}

/** get_spot — Pyth spot. */
export interface SpotView {
  asset: string;
  price: U64; // USDC base units per 1 whole asset
  conf: U64;
  publish_time: number;
  source: string; // e.g. "pyth-push-feed"
  [extra: string]: unknown;
}

export interface PriceCell {
  strike: U64;
  expiry: number;
  /** Totals for the requested size, USDC base units. */
  fair_premium: U64;
  bid_premium: U64;
  premium_start: U64;
  premium_floor: U64;
  fair_iv?: number;
  bid_iv?: number;
  venues?: { venue: string; mid_iv?: number; bid_iv?: number; age_secs?: number }[];
  quick_pricing?: boolean;
  /** Set when the pricer cannot price this cell (e.g. < 2 venues). */
  error?: string;
  [extra: string]: unknown;
}

export interface PriceGrid {
  asset: string;
  kind: RoundKind;
  size: U64;
  spot: U64;
  cells: PriceCell[];
  [extra: string]: unknown;
}

export interface FillProbability {
  asset: string;
  strike: U64;
  expiry: number;
  kind: RoundKind;
  /** Probability the round is exercised at expiry (put: settle < strike; call: settle > strike). */
  probability: number;
  iv?: number;
  [extra: string]: unknown;
}

export interface LendApy {
  mint: string;
  /** Devnet APY computed from the on-chain exchange rate, in bps (may be null if unknown). */
  devnet_apy_bps: number | null;
  /** Mainnet reference APY from Jupiter, in bps, labelled "mainnet reference". */
  mainnet_reference_apy_bps: number | null;
  [extra: string]: unknown;
}

export interface VenueDispersion {
  asset: string;
  expiry: number;
  venues_used: number;
  iv_spread_vol_pts: number | null;
  max_quote_age_secs?: number | null;
  [extra: string]: unknown;
}

export interface SpotMoves {
  asset: string;
  move_1h_pct: number | null;
  move_24h_pct: number | null;
  move_7d_pct: number | null;
  [extra: string]: unknown;
}

export interface MacroEvent {
  id: string;
  name: string;
  kind: "fomc" | "cpi" | "nfp" | string;
  at_utc: string; // ISO-8601
  at_unix: number;
  source: string;
  note?: string;
}

/**
 * The executor W implements (pricer + RPC). The desk wraps it: binds plan id, adds deterministic
 * derived fields, records traces, and serves `event_calendar` itself from data/events.json.
 */
export interface DeskTools {
  get_plan(args: { plan_id: string }): Promise<PlanView>;
  get_spot(args: { asset: string }): Promise<SpotView>;
  price_grid(args: {
    asset: string;
    kind: RoundKind;
    strikes: U64[];
    expiries: number[];
    size: U64;
  }): Promise<PriceGrid>;
  fill_probability(args: { asset: string; kind: RoundKind; strike: U64; expiry: number }): Promise<FillProbability>;
  lend_apy(args: { mint: string }): Promise<LendApy>;
  venue_dispersion(args: { asset: string; expiry: number }): Promise<VenueDispersion>;
  spot_moves(args: { asset: string }): Promise<SpotMoves>;
  /**
   * Deterministic outcome statistics of past rounds for this plan and for its asset (agents v2; no LLM involved).
   * Optional: when absent the desk reports that no outcome history is available.
   */
  recent_outcomes?(args: { plan_id: string; asset: string; limit: number }): Promise<RecentOutcomes>;
}

export interface RecentOutcomes {
  plan: unknown;
  asset: unknown;
  guidance: { may_inform: string[]; never_changes: string[]; caveat: string };
  [extra: string]: unknown;
}

export type ToolName = keyof DeskTools | "event_calendar";

export interface ToolTrace {
  call_id: string;
  name: string;
  args: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
  started_at: number; // unix ms
  duration_ms: number;
  /** Which Quant attempt made the call (0 = first, 1 = retry). */
  attempt: number;
}

// ---------------------------------------------------------------------------------------------
// Quant proposal
// ---------------------------------------------------------------------------------------------

export type QuantAction = "open" | "skip" | "flip" | "stop";

export interface QuantProposal {
  action: QuantAction;
  /** For action=open: all numeric fields set. For skip/flip/stop: null. */
  strike: U64 | null;
  size: U64 | null;
  expiry: number | null;
  auction_secs: number | null;
  premium_start: U64 | null;
  premium_floor: U64 | null;
  rationale: string;
}

// ---------------------------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------------------------

export type RiskBackendName = "glm" | "workers-ai" | "local";

export type Verdict = "approve" | "adjust" | "veto";

/** Probabilities per option, each in [0,1], normalised to sum 1 per question. */
export interface RiskAnswers {
  verdict: Record<Verdict, number>;
  event_risk: Record<"none" | "low" | "medium" | "high", number>;
  data_quality: Record<"good" | "fair" | "poor", number>;
  user_fit: Record<"matches" | "too_aggressive" | "too_passive", number>;
  explanation_ok: Record<"yes" | "no", number>;
}

export interface RiskResult {
  backend: RiskBackendName;
  model: string;
  answers: RiskAnswers;
  /** Backends that were tried and failed before this one (fallback chain). */
  fallbacks: { backend: RiskBackendName; error: string }[];
  /** Raw backend payload (for the memo / debugging). */
  raw?: unknown;
}

export interface RiskBinding {
  verdict: Verdict; // argmax
  /** Deterministic concern derived from the answers (used for the adjust retry). */
  top_concern: { question: keyof RiskAnswers; option: string; probability: number; text: string } | null;
}

// ---------------------------------------------------------------------------------------------
// Desk run
// ---------------------------------------------------------------------------------------------

export interface DeskInput {
  plan_id: string;
  kind: "preview" | "round";
  /** User's stated patience from the form (not on-chain). Risk sees it; Risk never sees bounds. */
  patience?: Patience;
  /** Set by retryWithChainError. */
  chain_retry?: { previous_memo_hash: string; error_code: string; previous_proposal: QuantProposal };
}

export type DeskStepName =
  | "start"
  | "quant_start"
  | "tool_call"
  | "quant_proposal"
  | "quant_repair"
  | "risk_start"
  | "risk_result"
  | "risk_fallback"
  | "quant_retry"
  | "final"
  | "memo"
  | "error";

export interface DeskStep {
  step: DeskStepName;
  at: number; // unix ms
  detail: Record<string, unknown>;
}

export type FinalStatus =
  | "open" // submit open_round with `final`
  | "skip"
  | "flip"
  | "stop"
  | "vetoed" // Risk vetoed → no open_round this cycle
  | "error"; // desk failed (model/key/tool error) → no open_round

export interface DeskFinal {
  status: FinalStatus;
  proposal: QuantProposal | null;
  reason: string;
}

export interface DeskMemo {
  inputs: {
    plan_id: string;
    kind: DeskInput["kind"];
    patience: Patience | null;
    chain_retry: DeskInput["chain_retry"] | null;
  };
  quant_proposal: { attempt: number; trigger: "initial" | "risk_adjust" | "chain_error"; proposal: QuantProposal | null; error?: string }[];
  clef_answers: { attempt: number; backend: RiskBackendName; model: string; answers: RiskAnswers; binding: RiskBinding; fallbacks: RiskResult["fallbacks"] }[];
  final: DeskFinal;
  tool_traces: ToolTrace[];
  model_ids: { quant: string; risk: string[] };
  timestamps: { started_at: number; finished_at: number };
  provenance: Record<string, boolean>;
  /** Whether the final rationale cites recent_outcomes (see orchestrator.citesRecentOutcomes). */
  outcomes_cited?: boolean | null;
}

export interface DeskResult {
  input: DeskInput;
  final: DeskFinal;
  memo: DeskMemo;
  /** Canonical JSON of `memo` (what was hashed). Store this (or `memo`) in desk_runs.memo. */
  memo_json: string;
  /** 32 bytes for open_round's memo_hash. */
  memo_hash: Uint8Array;
  memo_hash_hex: string;
  steps: DeskStep[];
  /** Plain-English card (null if the desk errored before get_plan). */
  card: import("./card.js").Card | null;
  /** Last get_plan result (for the keeper / card). */
  plan: PlanView | null;
}
