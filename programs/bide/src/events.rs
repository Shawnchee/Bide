use anchor_lang::prelude::*;

#[event]
pub struct PlanCreated {
    pub plan: Pubkey,
    pub owner: Pubkey,
    pub asset: Pubkey,
    pub side: u8,
    pub quick: bool,
    pub target_strike: u64,
    pub exit_strike: u64,
    pub size_total: u64,
    pub collateral_principal: u64,
    pub lend_shares: u64,
    pub horizon_end: i64,
}

#[event]
pub struct RoundOpened {
    pub round: Pubkey,
    pub plan: Pubkey,
    pub epoch: Pubkey,
    pub kind: u8,
    pub strike: u64,
    pub size: u64,
    pub notional: u64,
    pub expiry: i64,
    pub premium_start: u64,
    pub premium_floor: u64,
    pub spot_at_open: u64,
    pub memo_hash: [u8; 32],
}

#[event]
pub struct RoundTaken {
    pub round: Pubkey,
    pub plan: Pubkey,
    pub maker: Pubkey,
    pub premium: u64,
    pub fee: u64,
    pub is_pool: bool,
}

#[event]
pub struct EpochOpened {
    pub epoch: Pubkey,
    pub asset: Pubkey,
    pub kind: u8,
    pub expiry: i64,
}

#[event]
pub struct SamplePosted {
    pub epoch: Pubkey,
    pub bucket: u8,
    pub price: u64,
    pub publish_time: i64,
}

#[event]
pub struct EpochResolved {
    pub epoch: Pubkey,
    pub settle_price: u64,
    pub n_samples: u8,
}

#[event]
pub struct EpochFailed {
    pub epoch: Pubkey,
    pub n_samples: u8,
}

#[event]
pub struct RoundResolved {
    pub round: Pubkey,
    pub plan: Pubkey,
    pub settle_price: u64,
    pub exercised: bool,
}

#[event]
pub struct CollateralWithdrawn {
    pub round: Pubkey,
    pub plan: Pubkey,
    pub owed: u64,
    pub paid: u64,
    pub shares_burned: u64,
}

#[event]
pub struct RoundCancelled {
    pub round: Pubkey,
    pub plan: Pubkey,
}

#[event]
pub struct RoundUnwound {
    pub round: Pubkey,
    pub plan: Pubkey,
}

#[event]
pub struct PlanUpdated {
    pub plan: Pubkey,
}

#[event]
pub struct PlanFlipped {
    pub plan: Pubkey,
    pub size_total: u64,
    pub lend_shares: u64,
}

#[event]
pub struct PlanClosed {
    pub plan: Pubkey,
    pub collateral_returned: u64,
    pub asset_returned: u64,
}

#[event]
pub struct PlanExpired {
    pub plan: Pubkey,
    pub collateral_returned: u64,
    pub asset_returned: u64,
}

#[event]
pub struct PoolDeposited {
    pub lp: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub nav: u64,
}

#[event]
pub struct PoolWithdrawn {
    pub lp: Pubkey,
    pub shares: u64,
    pub usdc_out: u64,
    pub wsol_out: u64,
    pub f_token_out: u64,
}
