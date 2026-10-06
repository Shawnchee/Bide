// Bide on-chain contract constants (devnet). Mirrors programs/bide/src/constants.rs + BUILD §3.7.
import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe");

// ---- seeds ----
export const SEEDS = {
  config: "config",
  asset: "asset",
  plan: "plan",
  round: "round",
  epoch: "epoch",
  pool: "pool",
  poolMint: "pool_mint",
  escrow: "escrow",
  lendAuth: "lend_auth",
} as const;

// ---- mints ----
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;
export const TBTC_DECIMALS = 8;
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ---- Jupiter Lend (devnet) ----
export const LEND_PROGRAM_ID = new PublicKey("7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3");
export const LIQUIDITY_PROGRAM_ID = new PublicKey("5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL");
export const REWARDS_RATE_MODEL_PROGRAM_ID = new PublicKey("68LHLkpgjAvo6Lgd9FT6KYEX4FWn1911EohSXxHYMFjc");
export const LEND_LENDING_ADMIN = new PublicKey("DeF2BVMjWdCamK71nqBZ7uzQkLeW9MJ6C7zoCKLJXEmW");
export const LEND_LIQUIDITY = new PublicKey("DFHSbFzMU67yHK9yLsLBLso7aEnzrB4ZQR7KBujmSU3M");

export interface LendMarket {
  mint: PublicKey;
  fTokenMint: PublicKey;
  lending: PublicKey;
  reserve: PublicKey;
  rateModel: PublicKey;
  supplyPosition: PublicKey;
  vault: PublicKey;
  claimAccount: PublicKey;
  rewardsRateModel: PublicKey;
}

export const LEND_MARKETS: Record<"USDC" | "WSOL", LendMarket> = {
  USDC: {
    mint: USDC_MINT,
    fTokenMint: new PublicKey("2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu"),
    lending: new PublicKey("98Uy7eonumvRbhQvP5Jt7B3WjNqpndioMF99xvR7sDVa"),
    reserve: new PublicKey("644Eh222dNe1V6sSRkYHBcdpxfjtxBBptAJ6mZujRRNo"),
    rateModel: new PublicKey("CpSRFppSpkdPw7juvRpSxwVyZMN3y8g7cHXCbrc3MBUs"),
    supplyPosition: new PublicKey("B5JAZXGKaZfWsUrauprZVNQM7HwXN8AfKVTt25qtDKYV"),
    vault: new PublicKey("CWFPa1gcDqGyeTHTmdbhGjCnQv7eRfdhnBpZKFzNr1R2"),
    claimAccount: new PublicKey("dUnUR9XxaVWZo5FUi5DGqsMWfAzYPdtgkuiDbPLLtYX"),
    rewardsRateModel: new PublicKey("GGtryeuwjcWoG6zg4Xi1vUJN1xRhypms4xt129BKTUxt"),
  },
  WSOL: {
    mint: WSOL_MINT,
    fTokenMint: new PublicKey("BG892DUQW1NHQLinc4mabqH7EVeEfFWpVibAiNnggwmU"),
    lending: new PublicKey("GAvizzttfkgetRzkZY9fqzCYo3fJULM7E9V1Gq5CVTNS"),
    reserve: new PublicKey("BA6Sg5PUACHHUgK9emXGLdLXEVuPvWGZADo5ZqTLqVi1"),
    rateModel: new PublicKey("HNT4VUeaBaBMqqCa1oJWwG8g1TApZfAJR6e34h9JL5c1"),
    supplyPosition: new PublicKey("Gi2KLaG18VZYF6TG8qhTbuVjw3pANXuMjYsZkskasXzR"),
    vault: new PublicKey("GoT7214qjHGt6QNqQKhQmqFFVT3qVwzjZvUZK4enV8E7"),
    claimAccount: new PublicKey("8vVkrDGaQZz2wkVp3ta8WYRMiSQz2WD4ckEpHfmm2oiB"),
    rewardsRateModel: new PublicKey("CnKAZc6aSnncZRRM9K1bsP1ngS6yAayYYDBQBcQdTwef"),
  },
};

export function lendMarketForMint(mint: PublicKey): LendMarket | null {
  if (mint.equals(USDC_MINT)) return LEND_MARKETS.USDC;
  if (mint.equals(WSOL_MINT)) return LEND_MARKETS.WSOL;
  return null;
}

/** Lending.token_exchange_price: absolute byte offset, 1e12 precision. */
export const LENDING_TOKEN_EXCHANGE_PRICE_OFFSET = 115;
export const LEND_EXCHANGE_PRICE_PRECISION = 1_000_000_000_000n;

// ---- Pyth (devnet, upgraded set) ----
export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey("pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou");
export const WORMHOLE_PROGRAM_ID = new PublicKey("HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL");
export const WORMHOLE_GUARDIAN_SET = new PublicKey("59LY6jV5LcoEdXrhNhX7AJQmW1gHUHQWSLy3299CgGBY");
export const PYTH_RECEIVER_CONFIG = new PublicKey("H3R4M45f2gyqp6geVUruapzZdyxpgGZ96UnWkDM3ndye");
export const PYTH_FEED_IDS = {
  SOL_USD: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC_USD: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
} as const;
export const PYTH_PUSH_FEEDS = {
  SOL_USD: new PublicKey("7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE"),
  BTC_USD: new PublicKey("APgzQGGdv2qCgBkX6aHVkrGePtBVDDg68GiqaM7rmtf5"),
} as const;

// ---- fees / limits ----
export const BPS = 10_000;
export const FEE_BPS_DEFAULT = 1_000;
export const FEE_BPS_CAP = 2_000;
export const SECS_PER_DAY = 86_400;
export const MAX_HORIZON_SECS = 180 * SECS_PER_DAY;
export const MIN_HORIZON_SECS_STD = SECS_PER_DAY;
export const MIN_HORIZON_SECS_QUICK = 600;
export const CANCEL_ANYONE_DELAY_SECS = 60;
/** Request this CU limit on every tx that does a Lend CPI. */
export const LEND_TX_CU_LIMIT = 400_000;

// ---- epoch kinds (code constants in the program) ----
export const EPOCH_KIND = { Std: 0, Quick: 1 } as const;
export type EpochKindNum = (typeof EPOCH_KIND)[keyof typeof EPOCH_KIND];

export const EPOCH_PARAMS = {
  Std: {
    nBuckets: 10,
    bucketSecs: 180,
    bucketToleranceSecs: 10,
    graceSecs: 3_600,
    poolDelaySecs: 60,
    auctionSecsMin: 10,
    auctionSecsMax: 1_800,
    /** expiry mod 86400 == 28800 (08:00 UTC) */
    expiryTimeOfDaySecs: 28_800,
    /** open_round allowed iff (now − 08:00 UTC) mod 86400 < 1800 */
    auctionWindowSecs: 1_800,
    minSecsToExpiry: 12 * 3_600,
  },
  Quick: {
    nBuckets: 10,
    bucketSecs: 10,
    bucketToleranceSecs: 2,
    graceSecs: 120,
    poolDelaySecs: 10,
    auctionSecsMin: 5,
    auctionSecsMax: 120,
    /** expiry mod 600 == 0 */
    epochSecs: 600,
    /** open_round allowed iff now ∈ [expiry − 600, expiry − 540] */
    auctionWindowSecs: 60,
  },
} as const;

/** sampling window start: expiry − nBuckets × bucketSecs */
export function windowStart(expiry: number, kind: "Std" | "Quick"): number {
  const p = EPOCH_PARAMS[kind];
  return expiry - p.nBuckets * p.bucketSecs;
}

/** Next std expiry (08:00 UTC) at least `minAheadSecs` after `now`. */
export function nextStdExpiry(nowSecs: number, minAheadSecs = 0): number {
  const t = nowSecs + minAheadSecs;
  const day = Math.floor((t - 28_800) / SECS_PER_DAY);
  let e = day * SECS_PER_DAY + 28_800;
  while (e <= t) e += SECS_PER_DAY;
  return e;
}

/** Next quick expiry (multiple of 600) strictly after now. */
export function nextQuickExpiry(nowSecs: number): number {
  return (Math.floor(nowSecs / 600) + 1) * 600;
}
export const LEND_DUST_BUFFER = 10n; // extra base units deposited to Lend on create_plan (returned on close)
export const LEND_MIN_REDEEM_VALUE = 1_000n; // positions below this are left as dust on close (Lend rejects near-zero ops)

/** Devnet address lookup table (scripts/create-alt.ts): Lend market accounts (USDC+WSOL), programs, config, SOL asset, push feed. */
export const BIDE_ALT = new PublicKey("CEqxacEbFQ2oCJNWtPqQwYBWiyrwsiTakMN786efPoaT");

/** open_round rejects rounds below this notional (RoundTooSmall). */
export const MIN_ROUND_NOTIONAL = 1_000_000n;
/** Virtual shares/assets in pool share math (first-depositor inflation guard). */
export const POOL_VIRTUAL_OFFSET = 1_000n;
