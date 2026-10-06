use anchor_lang::prelude::*;

#[error_code]
pub enum BideError {
    #[msg("Epoch is not open")]
    EpochNotOpen,
    #[msg("Outside the auction window for this epoch kind")]
    OutsideAuctionWindow,
    #[msg("Epoch is not resolved")]
    EpochNotResolved,
    #[msg("Grace period has not elapsed")]
    GraceNotElapsed,
    #[msg("Plan has not expired")]
    PlanNotExpired,
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Plan is paused")]
    PlanPaused,
    #[msg("Asset is disabled")]
    AssetDisabled,
    #[msg("Strike outside the user's bounds")]
    StrikeOutOfBounds,
    #[msg("Strike is not on the asset tick")]
    StrikeOffTick,
    #[msg("Size exceeds the plan's remaining size")]
    SizeTooLarge,
    #[msg("Expiry outside the user's bounds")]
    ExpiryOutOfBounds,
    #[msg("Round rate limit reached")]
    RateLimited,
    #[msg("Premium below the user's signed minimum (after fee)")]
    PremiumBelowUserMin,
    #[msg("Invalid auction parameters")]
    AuctionParamsInvalid,
    #[msg("Plan already has an active round")]
    ActiveRoundExists,
    #[msg("Wrong status for this action")]
    WrongStatus,
    #[msg("Auction is over")]
    AuctionOver,
    #[msg("Pool window not reached")]
    PoolWindowNotReached,
    #[msg("Spot moved too much since the auction opened")]
    SpotMovedTooMuch,
    #[msg("Price is stale")]
    StalePrice,
    #[msg("Price confidence too wide")]
    PriceConfidenceTooWide,
    #[msg("Wrong price feed")]
    WrongFeed,
    #[msg("Bucket out of range")]
    BucketOutOfRange,
    #[msg("Bucket already filled")]
    BucketFilled,
    #[msg("Sample publish time outside the bucket")]
    SampleOutsideBucket,
    #[msg("Not enough samples")]
    NotEnoughSamples,
    #[msg("Not expired")]
    NotExpired,
    #[msg("Pool cap exceeded")]
    PoolCapExceeded,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Fee too high")]
    FeeTooHigh,
    #[msg("Invalid schedule")]
    InvalidSchedule,
    #[msg("Horizon out of range")]
    HorizonOutOfRange,
    #[msg("Pool is paused")]
    PoolPaused,
    #[msg("Insufficient free funds")]
    InsufficientFreeFunds,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Epoch failed")]
    EpochFailed,
    #[msg("A settlement is pending on this plan")]
    SettlementPending,
    #[msg("Epoch kind does not match the plan")]
    EpochKindMismatch,
    #[msg("Not a wheel plan")]
    NotWheelPlan,
    #[msg("Wrong plan phase")]
    WrongPhase,
    // ---- additions beyond BUILD §3.4 (account validation) ----
    #[msg("Invalid account")]
    InvalidAccount,
    #[msg("Invalid Jupiter Lend accounts")]
    InvalidLendAccounts,
    #[msg("Price update not fully verified")]
    NotFullyVerified,
    #[msg("Invalid plan parameters")]
    InvalidPlanParams,
    #[msg("Not implemented yet (ships in a program upgrade)")]
    NotImplemented,
    #[msg("Round notional below the minimum (1 USDC)")]
    RoundTooSmall,
}
