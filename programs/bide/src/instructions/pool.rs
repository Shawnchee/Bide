//! Backstop LP pool: LPs deposit USDC/WSOL for shares; the pool pays the floor premium on unfilled auctions.
//! All vaults are owned by the data-less PDA ["lend_auth", pool] (= pool_auth), which is also the share-mint authority.
use crate::{
    constants::*,
    errors::BideError,
    events::*,
    lend::{self, LendMarket, LendPrograms},
    math, oracle,
    state::*,
    util,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, MintTo};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PoolParams {
    pub max_premium_bps_of_notional: u16,
    pub max_open_notional: u64,
    pub max_utilization_bps: u16,
    pub spend_window_secs: u32,
    pub spend_window_cap: u64,
}

/// init_pool. Client creates pool vault ATAs (USDC, WSOL, USDC fToken; owner = pool_auth) idempotently first.
#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.admin == authority.key() @ BideError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = authority, space = 8 + Pool::INIT_SPACE, seeds = [SEED_POOL], bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: data-less PDA ["lend_auth", pool]: owns pool vaults, signs Lend CPIs, share mint authority
    #[account(seeds = [SEED_LEND_AUTH, pool.key().as_ref()], bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(
        init, payer = authority, seeds = [SEED_POOL_MINT], bump,
        mint::decimals = USDC_DECIMALS, mint::authority = pool_auth
    )]
    pub share_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn init_pool(ctx: Context<InitPool>, params: PoolParams) -> Result<()> {
    require!(params.max_utilization_bps as u64 <= BPS, BideError::InvalidPlanParams);
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.pool;
    p.authority = ctx.accounts.authority.key();
    p.max_premium_bps_of_notional = params.max_premium_bps_of_notional;
    p.max_open_notional = params.max_open_notional;
    p.max_utilization_bps = params.max_utilization_bps;
    p.spend_window_secs = params.spend_window_secs;
    p.spend_window_start = now;
    p.spend_window_cap = params.spend_window_cap;
    p.spend_window_spent = 0;
    p.paused = false;
    p.share_mint = ctx.accounts.share_mint.key();
    p.lend_shares = 0;
    p.reserved_usdc = 0;
    p.reserved_wsol = 0;
    p.open_notional = 0;
    p.put_open_size = 0;
    p.put_open_notional = 0;
    p.call_open_notional = 0;
    p.call_open_size = 0;
    p.bump = ctx.bumps.pool;
    p.lend_auth_bump = ctx.bumps.pool_auth;
    p.share_mint_bump = ctx.bumps.share_mint;
    Ok(())
}

/// Pool NAV components, USDC base units.
pub struct Nav {
    pub usdc: u64,
    pub lend_value: u64,
    pub wsol_value: u64,
    pub reserved_value: u64,
}

impl Nav {
    pub fn free(&self) -> Result<u64> {
        self.usdc
            .checked_add(self.lend_value)
            .and_then(|x| x.checked_add(self.wsol_value))
            .ok_or(error!(BideError::MathOverflow))
    }
    pub fn total(&self) -> Result<u64> {
        self.free()?.checked_add(self.reserved_value).ok_or(error!(BideError::MathOverflow))
    }
}

/// NAV = USDC vault + Lend USDC (shares × exchange price) + WSOL × spot + value of funds held outside the vaults.
///
/// Funds outside the vaults (`reserved_*`) are marked per leg (P1, codex_v2 / SPEC decision 2026-10-07):
/// - live pool Puts: the pool is the put BUYER holding escrowed SOL; at resolution it ends with either the SOL back
///   (not exercised) or the strike notional in USDC (exercised). Marked at intrinsic value
///   `max(spot × put_open_size, put_open_notional)`.
/// - live pool Calls: the pool escrowed the strike notional in USDC; it ends with either that USDC back or `size`
///   SOL. Marked `max(call_open_notional, spot × call_open_size)`.
/// - receivables of exercised rounds awaiting withdraw_collateral: USDC at face, WSOL at spot.
///
/// Why: marking the escrow at spot alone (the v1 rule) understated NAV whenever a pool option was in the money, and
/// between resolve_epoch (outcome public) and the permissionless resolve_round (books the receivable) anyone could
/// mint shares at the stale NAV and redeem after resolve_round, diluting existing LPs. The pool's payoff at
/// resolution is always ONE of the two legs, so `max(both)` ≥ the post-resolution value at the same spot: a deposit
/// can never buy shares below what resolve_round will book.
///
/// Limitations (documented, accepted):
/// - Σ max ≥ max Σ: the max is taken over the per-kind SUMS, not per round. With mixed strikes (some puts in, some
///   out of the money) `max(spot × Σsize, Σnotional)` ≤ `Σ max(spot × size_i, notional_i)`, i.e. the mark can still be
///   below the exact per-round intrinsic value. It is never below the v1 spot mark, and with one live round per
///   kind (the common case) it is exact.
/// - Time value is ignored (the pool is long the options, so NAV is slightly understated before expiry; epochs are
///   minutes-to-a-day long).
/// - The mark uses SPOT, not the epoch's settle price (the pool can't see epochs). After resolve_epoch, if spot has
///   crossed the strike since settlement, the mark overstates the outcome by at most |spot − strike| × size until
///   resolve_round runs (permissionless; the keeper calls it right away).
/// - Pools that had live rounds before migrate_pool have zero v2 sums: those rounds fall back to the v1 spot mark
///   (the reserved_* remainder is treated as receivables). The devnet pool had no take when migrated.
pub fn pool_nav(pool: &Pool, usdc_vault: u64, wsol_vault: u64, f_shares: u64, lending_usdc: &AccountInfo, spot: u64) -> Result<Nav> {
    let px = lend::token_exchange_price(lending_usdc)?;
    Ok(Nav {
        usdc: usdc_vault,
        lend_value: lend::shares_to_assets(f_shares, px)?,
        wsol_value: math::notional_floor(spot, wsol_vault, 9)?,
        reserved_value: reserved_value(pool, spot)?,
    })
}

/// Value (USDC base units) of everything the pool holds outside its vaults, per the marking rules on pool_nav.
pub fn reserved_value(pool: &Pool, spot: u64) -> Result<u64> {
    // live option legs at intrinsic value
    let put_leg = math::notional_floor(spot, pool.put_open_size, 9)?.max(pool.put_open_notional);
    let call_leg = pool.call_open_notional.max(math::notional_floor(spot, pool.call_open_size, 9)?);
    // the rest of reserved_* is receivables of exercised rounds (put: USDC at face; call: WSOL at spot)
    let usdc_receivable = pool.reserved_usdc.saturating_sub(pool.call_open_notional);
    let wsol_receivable_value = math::notional_floor(spot, pool.reserved_wsol.saturating_sub(pool.put_open_size), 9)?;
    put_leg
        .checked_add(call_leg)
        .and_then(|x| x.checked_add(usdc_receivable))
        .and_then(|x| x.checked_add(wsol_receivable_value))
        .ok_or(error!(BideError::MathOverflow))
}

fn f_token_balance(acc: &AccountInfo) -> Result<u64> {
    lend::token_amount(acc)
}

#[derive(Accounts)]
pub struct PoolDeposit<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(mut, seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA
    #[account(seeds = [SEED_LEND_AUTH, pool.key().as_ref()], bump = pool.lend_auth_bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(mut, address = pool.share_mint)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = lp)]
    pub lp_shares: Box<Account<'info, TokenAccount>>,
    /// USDC or WSOL
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = lp)]
    pub lp_source: Box<Account<'info, TokenAccount>>,
    #[account(
        mut, token::mint = USDC_MINT, token::authority = pool_auth,
        constraint = pool_usdc.key() == util::ata(&pool_auth.key(), &USDC_MINT) @ BideError::InvalidAccount
    )]
    pub pool_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        mut, token::mint = WSOL_MINT, token::authority = pool_auth,
        constraint = pool_wsol.key() == util::ata(&pool_auth.key(), &WSOL_MINT) @ BideError::InvalidAccount
    )]
    pub pool_wsol: Box<Account<'info, TokenAccount>>,
    /// SOL asset (spot feed params)
    #[account(seeds = [SEED_ASSET, WSOL_MINT.as_ref()], bump = sol_asset.bump)]
    pub sol_asset: Box<Account<'info, Asset>>,
    /// CHECK: Pyth SOL push feed (validated)
    pub spot_feed: UncheckedAccount<'info>,
    /// CHECK: Lend USDC lending account (exchange price)
    #[account(address = LEND_USDC_LENDING)]
    pub lending_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn pool_deposit(ctx: Context<PoolDeposit>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &ctx.accounts.pool;
    require!(!pool.paused, BideError::PoolPaused);
    require!(amount > 0, BideError::ZeroAmount);
    let mint = ctx.accounts.mint.key();
    require!(mint == USDC_MINT || mint == WSOL_MINT, BideError::InvalidMint);
    let spot = oracle::read_spot(&ctx.accounts.sol_asset, &ctx.accounts.spot_feed, now)?;
    let nav = pool_nav(
        pool,
        ctx.accounts.pool_usdc.amount,
        ctx.accounts.pool_wsol.amount,
        pool.lend_shares,
        &ctx.accounts.lending_usdc,
        spot,
    )?
    .total()?;
    let value = if mint == USDC_MINT { amount } else { math::notional_floor(spot, amount, 9)? };
    require!(value > 0, BideError::ZeroAmount);
    let supply = ctx.accounts.share_mint.supply;
    // virtual shares/assets: an attacker can't inflate the share price against the next depositor
    let shares = math::mul_div_floor(
        value,
        supply.checked_add(POOL_VIRTUAL_OFFSET).ok_or(BideError::MathOverflow)?,
        nav.checked_add(POOL_VIRTUAL_OFFSET).ok_or(BideError::MathOverflow)?,
    )?;
    require!(shares > 0, BideError::ZeroAmount);

    let tp = ctx.accounts.token_program.to_account_info();
    let dest = if mint == USDC_MINT { ctx.accounts.pool_usdc.to_account_info() } else { ctx.accounts.pool_wsol.to_account_info() };
    util::transfer(&tp, &ctx.accounts.lp_source.to_account_info(), &dest, &ctx.accounts.lp.to_account_info(), None, amount)?;
    let pool_key = pool.key();
    let seeds: &[&[u8]] = &[SEED_LEND_AUTH, pool_key.as_ref(), &[pool.lend_auth_bump]];
    let signer: &[&[&[u8]]] = &[seeds];
    token::mint_to(
        CpiContext::new_with_signer(
            tp.key(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.lp_shares.to_account_info(),
                authority: ctx.accounts.pool_auth.to_account_info(),
            },
            signer,
        ),
        shares,
    )?;
    emit!(PoolDeposited { lp: ctx.accounts.lp.key(), mint, amount, shares, nav });
    Ok(())
}

#[derive(Accounts)]
pub struct PoolWithdraw<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(mut, seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA
    #[account(seeds = [SEED_LEND_AUTH, pool.key().as_ref()], bump = pool.lend_auth_bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(mut, address = pool.share_mint)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = lp)]
    pub lp_shares: Box<Account<'info, TokenAccount>>,
    #[account(
        mut, token::mint = USDC_MINT, token::authority = pool_auth,
        constraint = pool_usdc.key() == util::ata(&pool_auth.key(), &USDC_MINT) @ BideError::InvalidAccount
    )]
    pub pool_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        mut, token::mint = WSOL_MINT, token::authority = pool_auth,
        constraint = pool_wsol.key() == util::ata(&pool_auth.key(), &WSOL_MINT) @ BideError::InvalidAccount
    )]
    pub pool_wsol: Box<Account<'info, TokenAccount>>,
    #[account(
        mut, token::mint = LEND_USDC_FTOKEN, token::authority = pool_auth,
        constraint = pool_f_token.key() == util::ata(&pool_auth.key(), &LEND_USDC_FTOKEN) @ BideError::InvalidAccount
    )]
    pub pool_f_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = USDC_MINT, token::authority = lp)]
    pub lp_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = WSOL_MINT, token::authority = lp)]
    pub lp_wsol: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = LEND_USDC_FTOKEN, token::authority = lp)]
    pub lp_f_token: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SEED_ASSET, WSOL_MINT.as_ref()], bump = sol_asset.bump)]
    pub sol_asset: Box<Account<'info, Asset>>,
    /// CHECK: Pyth SOL push feed (validated)
    pub spot_feed: UncheckedAccount<'info>,
    /// CHECK: Lend USDC lending account
    #[account(address = LEND_USDC_LENDING)]
    pub lending_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Pays the LP's share of NAV in kind, pro-rata from the FREE assets (USDC vault, jlUSDC, WSOL vault).
/// Fails with InsufficientFreeFunds if the LP's NAV share exceeds the free (unreserved) value.
pub fn pool_withdraw(ctx: Context<PoolWithdraw>, shares: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(shares > 0, BideError::ZeroAmount);
    let pool = &ctx.accounts.pool;
    let spot = oracle::read_spot(&ctx.accounts.sol_asset, &ctx.accounts.spot_feed, now)?;
    let usdc = ctx.accounts.pool_usdc.amount;
    let wsol = ctx.accounts.pool_wsol.amount;
    let f = ctx.accounts.pool_f_token.amount;
    let nav = pool_nav(pool, usdc, wsol, f, &ctx.accounts.lending_usdc, spot)?;
    let supply = ctx.accounts.share_mint.supply;
    require!(supply > 0 && shares <= supply, BideError::InsufficientFreeFunds);
    let value = math::mul_div_floor(
        shares,
        nav.total()?.checked_add(POOL_VIRTUAL_OFFSET).ok_or(BideError::MathOverflow)?,
        supply.checked_add(POOL_VIRTUAL_OFFSET).ok_or(BideError::MathOverflow)?,
    )?;
    let free = nav.free()?;
    require!(value <= free && free > 0, BideError::InsufficientFreeFunds);
    let usdc_out = math::mul_div_floor(usdc, value, free)?;
    let wsol_out = math::mul_div_floor(wsol, value, free)?;
    let f_out = math::mul_div_floor(f, value, free)?;

    let tp = ctx.accounts.token_program.to_account_info();
    token::burn(
        CpiContext::new(
            tp.key(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.lp_shares.to_account_info(),
                authority: ctx.accounts.lp.to_account_info(),
            },
        ),
        shares,
    )?;
    let pool_key = pool.key();
    let seeds: &[&[u8]] = &[SEED_LEND_AUTH, pool_key.as_ref(), &[pool.lend_auth_bump]];
    let auth = ctx.accounts.pool_auth.to_account_info();
    util::transfer(&tp, &ctx.accounts.pool_usdc.to_account_info(), &ctx.accounts.lp_usdc.to_account_info(), &auth, Some(seeds), usdc_out)?;
    util::transfer(&tp, &ctx.accounts.pool_wsol.to_account_info(), &ctx.accounts.lp_wsol.to_account_info(), &auth, Some(seeds), wsol_out)?;
    util::transfer(&tp, &ctx.accounts.pool_f_token.to_account_info(), &ctx.accounts.lp_f_token.to_account_info(), &auth, Some(seeds), f_out)?;
    let pool = &mut ctx.accounts.pool;
    pool.lend_shares = pool.lend_shares.saturating_sub(f_out);
    emit!(PoolWithdrawn { lp: ctx.accounts.lp.key(), shares, usdc_out, wsol_out, f_token_out: f_out });
    Ok(())
}

/// pool_lend_idle / pool_unlend. Remaining: 13 USDC Lend market accounts.
#[derive(Accounts)]
pub struct PoolLend<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA
    #[account(mut, seeds = [SEED_LEND_AUTH, pool.key().as_ref()], bump = pool.lend_auth_bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(
        mut, token::mint = USDC_MINT, token::authority = pool_auth,
        constraint = pool_usdc.key() == util::ata(&pool_auth.key(), &USDC_MINT) @ BideError::InvalidAccount
    )]
    pub pool_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        mut, token::mint = LEND_USDC_FTOKEN, token::authority = pool_auth,
        constraint = pool_f_token.key() == util::ata(&pool_auth.key(), &LEND_USDC_FTOKEN) @ BideError::InvalidAccount
    )]
    pub pool_f_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn pool_lend_common<'info>(ctx: Context<'info, PoolLend<'info>>, amount: u64, lend_in: bool) -> Result<()> {
    let s = ctx.accounts.signer.key();
    require!(s == ctx.accounts.pool.authority || s == ctx.accounts.config.agent, BideError::Unauthorized);
    require!(amount > 0, BideError::ZeroAmount);
    let pool_key = ctx.accounts.pool.key();
    let seeds: &[&[u8]] = &[SEED_LEND_AUTH, pool_key.as_ref(), &[ctx.accounts.pool.lend_auth_bump]];
    let m = LendMarket::from_remaining(ctx.remaining_accounts, 0, &USDC_MINT)?;
    let tp = ctx.accounts.token_program.to_account_info();
    let progs = LendPrograms {
        token_program: &tp,
        associated_token_program: &ctx.accounts.associated_token_program.to_account_info(),
        system_program: &ctx.accounts.system_program.to_account_info(),
    };
    let auth = ctx.accounts.pool_auth.to_account_info();
    let usdc = ctx.accounts.pool_usdc.to_account_info();
    let f = ctx.accounts.pool_f_token.to_account_info();
    if lend_in {
        require!(amount <= ctx.accounts.pool_usdc.amount, BideError::InsufficientFreeFunds);
        lend::deposit(&m, &progs, &auth, seeds, &usdc, &f, amount)?;
    } else {
        lend::withdraw(&m, &progs, &auth, seeds, &f, &usdc, amount)?;
    }
    let pool = &mut ctx.accounts.pool;
    pool.lend_shares = lend::token_amount(&f)?;
    Ok(())
}

/// Park idle pool USDC in Jupiter Lend (pool authority or keeper). Remaining: 13 USDC Lend market accounts.
pub fn pool_lend_idle<'info>(ctx: Context<'info, PoolLend<'info>>, amount: u64) -> Result<()> {
    pool_lend_common(ctx, amount, true)
}

/// Withdraw `amount` USDC (withdraw-by-amount) from Lend back to the pool vault.
pub fn pool_unlend<'info>(ctx: Context<'info, PoolLend<'info>>, amount: u64) -> Result<()> {
    pool_lend_common(ctx, amount, false)
}

#[derive(Accounts)]
pub struct SetPoolPaused<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SEED_POOL], bump = pool.bump, has_one = authority @ BideError::Unauthorized)]
    pub pool: Box<Account<'info, Pool>>,
}

/// Addition: pool authority kill switch / param update.
pub fn set_pool_params(ctx: Context<SetPoolPaused>, paused: bool, params: PoolParams) -> Result<()> {
    require!(params.max_utilization_bps as u64 <= BPS, BideError::InvalidPlanParams);
    let p = &mut ctx.accounts.pool;
    p.paused = paused;
    p.max_premium_bps_of_notional = params.max_premium_bps_of_notional;
    p.max_open_notional = params.max_open_notional;
    p.max_utilization_bps = params.max_utilization_bps;
    p.spend_window_secs = params.spend_window_secs;
    p.spend_window_cap = params.spend_window_cap;
    Ok(())
}

/// migrate_pool: admin-only, one-shot. Grows a Pool account created before the v2 fields (POOL_V1_LEN bytes) to the
/// current size; the appended v2 fields (put/call open sums) are zero-initialised by the resize. The admin pays the
/// extra rent. Takes the pool as an unchecked account because the v1 bytes don't deserialize as the current Pool.
#[derive(Accounts)]
pub struct MigratePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ BideError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the ["pool"] PDA; owner, discriminator and v1 length are checked in the handler
    #[account(mut, seeds = [SEED_POOL], bump)]
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn migrate_pool(ctx: Context<MigratePool>) -> Result<()> {
    let pool = ctx.accounts.pool.to_account_info();
    require_keys_eq!(*pool.owner, crate::ID, BideError::InvalidAccount);
    let new_len = 8 + Pool::INIT_SPACE;
    {
        let d = pool.try_borrow_data()?;
        require!(d.len() >= 8 && d[..8] == *Pool::DISCRIMINATOR, BideError::InvalidAccount);
        // only a v1 account can be migrated (re-running on a migrated pool is refused)
        require!(d.len() == POOL_V1_LEN, BideError::WrongStatus);
    }
    let need = Rent::get()?.minimum_balance(new_len).saturating_sub(pool.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to: pool.clone() },
            ),
            need,
        )?;
    }
    pool.resize(new_len)?;
    // resize zero-fills the grown region; zero the v2 fields explicitly anyway (defensive, documents intent)
    let mut d = pool.try_borrow_mut_data()?;
    d[POOL_V1_LEN..new_len].fill(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;
    const USD: u64 = 1_000_000;

    fn pool() -> Pool {
        Pool {
            authority: Pubkey::default(),
            max_premium_bps_of_notional: 0,
            max_open_notional: 0,
            max_utilization_bps: 0,
            spend_window_secs: 0,
            spend_window_start: 0,
            spend_window_cap: 0,
            spend_window_spent: 0,
            paused: false,
            share_mint: Pubkey::default(),
            lend_shares: 0,
            reserved_usdc: 0,
            reserved_wsol: 0,
            open_notional: 0,
            bump: 0,
            lend_auth_bump: 0,
            share_mint_bump: 0,
            put_open_size: 0,
            put_open_notional: 0,
            call_open_notional: 0,
            call_open_size: 0,
        }
    }

    #[test]
    fn v1_len_matches_the_old_layout() {
        // 8 disc + 32 + 2 + 8 + 2 + 4 + 8 + 8 + 8 + 1 + 32 + 8*4 + 3 = 148 (the devnet pool's size before v2)
        assert_eq!(POOL_V1_LEN, 148);
        assert_eq!(8 + Pool::INIT_SPACE, 180);
    }

    #[test]
    fn put_leg_marked_at_intrinsic() {
        // live put: 1 SOL escrowed, strike 100 → pool gets 100 USDC if exercised
        let mut p = pool();
        p.reserved_wsol = SOL;
        p.put_open_size = SOL;
        p.put_open_notional = 100 * USD;
        assert_eq!(reserved_value(&p, 80 * USD).unwrap(), 100 * USD, "ITM put: strike, not spot");
        assert_eq!(reserved_value(&p, 120 * USD).unwrap(), 120 * USD, "OTM put: the SOL at spot");
    }

    #[test]
    fn call_leg_marked_at_intrinsic() {
        // live call: 100 USDC escrowed, size 1 SOL → pool gets 1 SOL if exercised
        let mut p = pool();
        p.reserved_usdc = 100 * USD;
        p.call_open_notional = 100 * USD;
        p.call_open_size = SOL;
        assert_eq!(reserved_value(&p, 80 * USD).unwrap(), 100 * USD, "OTM call: the escrowed USDC");
        assert_eq!(reserved_value(&p, 130 * USD).unwrap(), 130 * USD, "ITM call: 1 SOL at spot");
    }

    #[test]
    fn receivables_at_face_and_spot_alongside_live_legs() {
        let mut p = pool();
        // live put (1 SOL, strike 100) + exercised-put receivable 50 USDC
        // live call (100 USDC, 1 SOL) + exercised-call receivable 2 SOL
        p.put_open_size = SOL;
        p.put_open_notional = 100 * USD;
        p.call_open_notional = 100 * USD;
        p.call_open_size = SOL;
        p.reserved_wsol = SOL + 2 * SOL;
        p.reserved_usdc = 100 * USD + 50 * USD;
        // spot 90: put leg 100, call leg 100, usdc rec 50, wsol rec 180
        assert_eq!(reserved_value(&p, 90 * USD).unwrap(), 430 * USD);
    }

    #[test]
    fn mark_never_below_post_resolution_value() {
        // the pool ends with one of the two legs; the mark is the max of both, at the same spot
        for spot in [50u64, 99, 100, 101, 150] {
            let mut p = pool();
            p.reserved_wsol = SOL;
            p.put_open_size = SOL;
            p.put_open_notional = 100 * USD;
            let mark = reserved_value(&p, spot * USD).unwrap();
            let exercised = 100 * USD; // receivable after release_pool
            let not_exercised = spot * USD; // SOL back in the vault, valued at spot
            assert!(mark >= exercised && mark >= not_exercised);
        }
    }

    #[test]
    fn migrated_v1_live_round_falls_back_to_spot_mark() {
        // a v1 pool migrated while a put was live: sums are zero, the escrow is valued like a WSOL receivable
        let mut p = pool();
        p.reserved_wsol = SOL;
        assert_eq!(reserved_value(&p, 80 * USD).unwrap(), 80 * USD);
    }
}
