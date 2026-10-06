use anchor_lang::prelude::*;

// ---------- seeds ----------
pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_ASSET: &[u8] = b"asset";
pub const SEED_PLAN: &[u8] = b"plan";
pub const SEED_ROUND: &[u8] = b"round";
pub const SEED_EPOCH: &[u8] = b"epoch";
pub const SEED_POOL: &[u8] = b"pool";
pub const SEED_POOL_MINT: &[u8] = b"pool_mint";
pub const SEED_ESCROW: &[u8] = b"escrow";
pub const SEED_LEND_AUTH: &[u8] = b"lend_auth";

// ---------- mints (devnet) ----------
pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const USDC_DECIMALS: u8 = 6;

// ---------- Jupiter Lend (devnet) ----------
pub const LEND_PROGRAM: Pubkey = pubkey!("7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3");
pub const LIQUIDITY_PROGRAM: Pubkey = pubkey!("5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL");
pub const LEND_USDC_FTOKEN: Pubkey = pubkey!("2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu");
pub const LEND_USDC_LENDING: Pubkey = pubkey!("98Uy7eonumvRbhQvP5Jt7B3WjNqpndioMF99xvR7sDVa");
pub const LEND_WSOL_FTOKEN: Pubkey = pubkey!("BG892DUQW1NHQLinc4mabqH7EVeEfFWpVibAiNnggwmU");
pub const LEND_WSOL_LENDING: Pubkey = pubkey!("GAvizzttfkgetRzkZY9fqzCYo3fJULM7E9V1Gq5CVTNS");
/// Lending.token_exchange_price: absolute byte offset (8-byte discriminator + 107), 1e12 precision
pub const LENDING_TOKEN_EXCHANGE_PRICE_OFFSET: usize = 115;
pub const LEND_EXCHANGE_PRICE_PRECISION: u128 = 1_000_000_000_000;

// ---------- Pyth (devnet, upgraded set) ----------
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");

// ---------- fees / limits ----------
pub const BPS: u64 = 10_000;
pub const FEE_BPS_DEFAULT: u16 = 1_000;
pub const FEE_BPS_CAP: u16 = 2_000;
pub const SECS_PER_DAY: i64 = 86_400;
pub const MAX_HORIZON_SECS: i64 = 180 * SECS_PER_DAY;
pub const MIN_HORIZON_SECS_STD: i64 = SECS_PER_DAY;
pub const MIN_HORIZON_SECS_QUICK: i64 = 600;
pub const MAX_SAMPLES: usize = 10;

// ---------- epoch kinds (code constants, BUILD §3.2) ----------
pub const STD_N_BUCKETS: u8 = 10;
pub const STD_BUCKET_SECS: u32 = 180;
pub const STD_BUCKET_TOLERANCE_SECS: u32 = 10;
pub const STD_GRACE_SECS: u32 = 3_600;
pub const STD_POOL_DELAY_SECS: u32 = 60;
pub const STD_AUCTION_SECS_MIN: u32 = 10;
pub const STD_AUCTION_SECS_MAX: u32 = 1_800;
/// open_round allowed iff (now - 08:00 UTC) mod 86400 < STD_AUCTION_WINDOW_SECS
pub const STD_EXPIRY_TOD_SECS: i64 = 28_800; // 08:00 UTC
pub const STD_AUCTION_WINDOW_SECS: i64 = 1_800;
pub const STD_MIN_SECS_TO_EXPIRY: i64 = 12 * 3_600;

pub const QUICK_N_BUCKETS: u8 = 10;
pub const QUICK_BUCKET_SECS: u32 = 10;
pub const QUICK_BUCKET_TOLERANCE_SECS: u32 = 2;
pub const QUICK_GRACE_SECS: u32 = 120;
pub const QUICK_POOL_DELAY_SECS: u32 = 10;
pub const QUICK_EPOCH_SECS: i64 = 600;
/// open_round allowed iff now in [expiry - 600, expiry - 540]
pub const QUICK_AUCTION_WINDOW_SECS: i64 = 60;
pub const QUICK_AUCTION_SECS_MIN: u32 = 5;
pub const QUICK_AUCTION_SECS_MAX: u32 = 120;

/// cancel_round becomes permissionless this long after the pool window opens
pub const CANCEL_ANYONE_DELAY_SECS: i64 = 60;

/// Extra base units deposited into Lend on top of the principal so Lend's share rounding (deposit rounds shares
/// down, withdraw-by-amount burns shares up) never leaves the plan 1 unit short of `notional`. Returned on close.
pub const LEND_DUST_BUFFER: u64 = 10;
/// Lend rejects near-zero operations (OperateAmountsNearlyZero, 6028). Positions worth less than this many base
/// units are left in the vault as dust on close/expire instead of being redeemed.
pub const LEND_MIN_REDEEM_VALUE: u64 = 1_000;
/// Smallest round notional (USDC base units). Below this, settlement amounts can fall under Lend's minimum
/// operate amount and withdraw_collateral could never complete.
pub const MIN_ROUND_NOTIONAL: u64 = 1_000_000;
/// Virtual shares / virtual assets in the pool share math (first-depositor inflation guard).
pub const POOL_VIRTUAL_OFFSET: u64 = 1_000;
