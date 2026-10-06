use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub agent: Pubkey,
    pub paused: bool,
    pub fee_bps: u16,
    pub fee_recipient: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Asset {
    pub mint: Pubkey,
    pub decimals: u8,
    pub pyth_feed_id: [u8; 32],
    /// Pyth sponsored push-feed account (PriceUpdateV2 owned by the receiver) used for auction spot
    pub spot_feed: Pubkey,
    /// Jupiter Lend fToken mint for this asset's market (Pubkey::default() = no Lend, plain vault e.g. tBTC)
    pub lend_f_token_mint: Pubkey,
    pub strike_tick: u64,
    pub max_conf_bps: u16,
    pub max_spot_move_bps: u16,
    pub max_spot_age_secs: u32,
    pub enabled: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Buy,
    Sell,
    Wheel,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Phase {
    Accumulate,
    Exit,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PlanStatus {
    Active,
    Filled,
    Closed,
}

#[account]
#[derive(InitSpace)]
pub struct Plan {
    pub owner: Pubkey,
    pub asset: Pubkey,
    pub asset_mint: Pubkey,
    pub nonce: u64,
    pub side: Side,
    pub phase: Phase,
    pub quick: bool,
    pub target_strike: u64,
    pub lock_strike: bool,
    pub band: u64,
    pub strike_min: u64,
    pub strike_max: u64,
    pub exit_strike: u64,
    pub exit_band: u64,
    pub call_strike_min: u64,
    pub call_strike_max: u64,
    pub size_total: u64,
    pub size_filled: u64,
    /// USDC (Buy / Wheel-Accumulate) or asset units (Sell / Wheel-Exit) principal deposited
    pub collateral_principal: u64,
    /// fTokens held by the plan's lend_auth vault for the current phase's market
    pub lend_shares: u64,
    pub pending_settlement: Option<Pubkey>,
    pub min_premium_bps_per_day: u16,
    pub max_expiry_secs: u32,
    pub horizon_end: i64,
    pub max_rounds_per_day: u8,
    pub rounds_today: u8,
    pub day_index: u32,
    pub round_count: u32,
    pub active_round: Option<Pubkey>,
    pub paused: bool,
    pub status: PlanStatus,
    pub created_at: i64,
    pub bump: u8,
    pub lend_auth_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoundKind {
    Put,
    Call,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoundStatus {
    Auction,
    Live,
    Cancelled,
    Resolved,
    Settled,
    Unwound,
}

pub const EXERCISED_UNKNOWN: u8 = 0;
pub const EXERCISED_NO: u8 = 1;
pub const EXERCISED_YES: u8 = 2;

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub plan: Pubkey,
    pub asset: Pubkey,
    pub round_index: u32,
    pub kind: RoundKind,
    pub strike: u64,
    pub size: u64,
    pub notional: u64,
    pub epoch: Pubkey,
    pub expiry: i64,
    pub auction_start: i64,
    pub auction_secs: u32,
    pub pool_delay_secs: u32,
    pub rent_payer: Pubkey,
    pub premium_start: u64,
    pub premium_floor: u64,
    pub spot_at_open: u64,
    pub maker: Pubkey,
    pub maker_is_pool: bool,
    pub premium_paid: u64,
    pub fee_paid: u64,
    pub exercised: u8,
    pub settle_price: u64,
    pub memo_hash: [u8; 32],
    pub status: RoundStatus,
    pub bump: u8,
    pub escrow_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum EpochKind {
    Std,
    Quick,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum EpochStatus {
    Open,
    Sampling,
    Resolved,
    Failed,
}

#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub asset: Pubkey,
    pub kind: EpochKind,
    pub expiry: i64,
    pub n_buckets: u8,
    pub bucket_secs: u32,
    /// u32 (BUILD says u8) so a Plan-B tolerance of a whole 300 s bucket fits
    pub bucket_tolerance_secs: u32,
    pub grace_secs: u32,
    pub samples: [u64; 10],
    pub sample_mask: u16,
    pub settle_price: u64,
    pub status: EpochStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub max_premium_bps_of_notional: u16,
    pub max_open_notional: u64,
    pub max_utilization_bps: u16,
    pub spend_window_secs: u32,
    pub spend_window_start: i64,
    pub spend_window_cap: u64,
    pub spend_window_spent: u64,
    pub paused: bool,
    pub share_mint: Pubkey,
    pub lend_shares: u64,
    /// USDC held outside the vaults: escrow of live pool Calls (= call_open_notional) + receivables of exercised
    /// pool Puts awaiting withdraw_collateral.
    pub reserved_usdc: u64,
    /// WSOL held outside the vaults: escrow of live pool Puts (= put_open_size) + receivables of exercised pool Calls
    /// awaiting withdraw_collateral.
    pub reserved_wsol: u64,
    pub open_notional: u64,
    pub bump: u8,
    pub lend_auth_bump: u8,
    pub share_mint_bump: u8,
    // ---- v2 (2026-10-07, appended; old accounts are grown by migrate_pool) ----
    // Per-kind sums over LIVE pool-held rounds, so pool_nav can mark each option leg at intrinsic value.
    /// Σ size (WSOL) escrowed by live pool Puts (subset of reserved_wsol).
    pub put_open_size: u64,
    /// Σ strike notional (USDC) of live pool Puts: what the pool receives if they are exercised.
    pub put_open_notional: u64,
    /// Σ notional (USDC) escrowed by live pool Calls (subset of reserved_usdc).
    pub call_open_notional: u64,
    /// Σ size (WSOL) of live pool Calls: what the pool receives if they are exercised.
    pub call_open_size: u64,
}

/// Size of a Pool account created before the v2 fields were appended (8-byte discriminator included).
pub const POOL_V1_LEN: usize = 8 + Pool::INIT_SPACE - 4 * 8;
