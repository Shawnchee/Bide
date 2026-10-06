// Row types mirroring supabase/migrations (BUILD §7). Amounts as strings (numeric) to avoid precision loss.
export interface QuoteRow {
  asset: string; ts?: string; fair_iv: number | null; bid_iv: number | null; venues: unknown; quick_pricing: boolean;
  kind?: string; strike?: string; expiry?: string; spot?: number; fair_premium?: string; bid_premium?: string; premium_start?: string; premium_floor?: string;
}
export interface DeskRunRow {
  id?: string; plan_pubkey: string | null; kind: "preview" | "round"; steps?: unknown[]; proposal?: unknown; verdict?: unknown; final?: unknown;
  memo?: unknown; card?: unknown; memo_hash?: string | null; tx_sig?: string | null; error_code?: string | null; status?: string; created_at?: string; updated_at?: string;
}
export interface PlanRow {
  plan_pubkey: string; owner: string; asset: string; side: string; phase: string | null; quick: boolean; target_strike: string; exit_strike: string;
  size_total: string; size_filled: string; horizon_end: string; status: string; updated_at?: string;
}
export interface RoundRow {
  round_pubkey: string; plan_pubkey: string; kind: string; strike: string; size: string; notional: string; expiry: string; auction_start: string;
  premium_start: string; premium_floor: string; premium_paid: string; fee_paid: string; maker: string | null; is_pool: boolean; status: string;
  settle_price: string | null; exercised: number; memo_hash: string; sigs?: Record<string, string>; updated_at?: string;
  /** Added by 20261006090000_agents.sql (recent_outcomes needs them). */
  asset?: string; auction_secs?: number; pool_delay_secs?: number;
}
export interface EpochRow {
  epoch_pubkey: string; asset: string; kind: string; expiry: string; samples: string[]; sample_mask: number; settle_price: string | null; status: string; updated_at?: string;
}
/** One maker agent's stance for an (asset, epoch, round kind). 20261006090000_agents.sql */
export interface MakerStanceRow {
  id?: string; stance_key: string; asset: string; epoch_pubkey: string; expiry: string; kind: "put" | "call"; maker: string; persona: string;
  source: "llm" | "fallback"; model: string | null; stance: "bid" | "pass" | null; spread_pct: number | null; thesis: string | null; confidence: number | null;
  grounded: boolean | null; fallback_reason: string | null; context: unknown; stance_hash: string; latency_ms: number | null; created_at?: string;
}
/** Per-maker, per-round bid ledger (P&L filled at resolve). */
export interface MakerBidRow {
  id?: string; round_pubkey: string; plan_pubkey: string; maker: string; maker_pubkey: string; stance_id: string | null; source: "llm" | "fallback";
  stance: "bid" | "pass"; spread_pct: number | null; fair_at_bid: string | null; bid: string | null; thesis: string | null; confidence: number | null;
  reason: string | null; bid_hash: string; took: boolean; tx_sig: string | null; pnl_usdc: string | null; created_at?: string;
}
export interface IntakeRunRow {
  id?: string; text: string; status: "running" | "done" | "error"; fields?: unknown; assumptions?: unknown; questions?: unknown;
  model?: string | null; error?: string | null; latency_ms?: number | null; created_at?: string; updated_at?: string;
}


export interface Repo {
  readonly backend: "supabase" | "memory";
  insertQuote(q: QuoteRow): Promise<void>;
  latestQuote(asset: string): Promise<QuoteRow | null>;
  createDeskRun(r: DeskRunRow): Promise<string>;
  updateDeskRun(id: string, patch: Partial<DeskRunRow>): Promise<void>;
  /** Append one step to desk_runs.steps (progress streaming for /earn preview). */
  appendDeskStep(id: string, step: unknown): Promise<void>;
  getDeskRun(id: string): Promise<DeskRunRow | null>;
  /** Mark desk runs still `running` that were created before `before` (ISO) as `abandoned` (killed by a restart). Returns the count. */
  abandonStaleDeskRuns(before: string): Promise<number>;
  upsertPlans(rows: PlanRow[]): Promise<void>;
  upsertRounds(rows: RoundRow[]): Promise<void>;
  /** Merge one signature into rounds.sigs (e.g. { take: sig }). */
  addRoundSig(round: string, label: string, sig: string): Promise<void>;
  upsertEpochs(rows: EpochRow[]): Promise<void>;
  getReference(key: string): Promise<{ value: unknown; updated_at: string } | null>;
  setReference(key: string, value: unknown): Promise<void>;
  // ---- AI agents (20261006090000_agents.sql) ----
  insertMakerStance(r: MakerStanceRow): Promise<string>;
  getMakerStance(stanceKey: string, maker: string): Promise<MakerStanceRow | null>;
  insertMakerBid(r: MakerBidRow): Promise<string>;
  markMakerBidTook(round: string, maker: string, txSig: string): Promise<void>;
  setMakerBidPnl(round: string, makerPubkey: string, pnlUsdc: string): Promise<void>;
  listMakerBids(q: { maker?: string; round?: string; took?: boolean; limit?: number }): Promise<MakerBidRow[]>;
  /** Most recent rounds, newest first (by auction_start). */
  listRounds(q: { plan?: string; asset?: string; limit?: number }): Promise<RoundRow[]>;
  createIntakeRun(r: IntakeRunRow): Promise<string>;
  updateIntakeRun(id: string, patch: Partial<IntakeRunRow>): Promise<void>;
  getIntakeRun(id: string): Promise<IntakeRunRow | null>;
}
