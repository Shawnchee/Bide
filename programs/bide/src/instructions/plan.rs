use crate::{
    constants::*,
    errors::BideError,
    events::*,
    lend::{self, LendMarket, LendPrograms},
    math,
    state::*,
    util,
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePlanArgs {
    pub nonce: u64,
    pub side: Side,
    pub quick: bool,
    pub target_strike: u64,
    pub exit_strike: u64,
    pub size_total: u64,
    pub lock_strike: bool,
    pub band: u64,
    pub exit_band: u64,
    pub min_premium_bps_per_day: u16,
    pub max_expiry_secs: u32,
    pub horizon_end: i64,
    pub max_rounds_per_day: u8,
}

/// create_plan. Remaining accounts: the 13 Lend market accounts of `collateral_mint`
/// (omit for an asset without Lend, e.g. tBTC Sell).
/// Client must create `vault_collateral` / `vault_f_token` (ATAs owned by lend_auth) idempotently before.
#[derive(Accounts)]
#[instruction(args: CreatePlanArgs)]
pub struct CreatePlan<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(
        init, payer = owner, space = 8 + Plan::INIT_SPACE,
        seeds = [SEED_PLAN, owner.key().as_ref(), &args.nonce.to_le_bytes()], bump
    )]
    pub plan: Box<Account<'info, Plan>>,
    /// CHECK: data-less PDA signer for Lend + owner of all plan vaults
    #[account(mut, seeds = [SEED_LEND_AUTH, plan.key().as_ref()], bump)]
    pub lend_auth: UncheckedAccount<'info>,
    /// USDC for Buy/Wheel, asset mint for Sell
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = collateral_mint, token::authority = owner)]
    pub owner_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = lend_auth)]
    pub vault_collateral: Box<Account<'info, TokenAccount>>,
    /// ATA(fToken of collateral_mint, lend_auth); None if the collateral has no Lend market
    #[account(mut)]
    pub vault_f_token: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub struct PlanBounds {
    pub strike_min: u64,
    pub strike_max: u64,
    pub call_strike_min: u64,
    pub call_strike_max: u64,
}

pub fn validate_bounds(
    asset: &Asset,
    side: Side,
    target: u64,
    exit: u64,
    lock: bool,
    band: u64,
    exit_band: u64,
) -> Result<PlanBounds> {
    let tick = asset.strike_tick;
    let mut b = PlanBounds { strike_min: 0, strike_max: 0, call_strike_min: 0, call_strike_max: 0 };
    if side == Side::Buy || side == Side::Wheel {
        require!(target > 0, BideError::ZeroAmount);
        require!(target % tick == 0, BideError::StrikeOffTick);
        let band = if lock { 0 } else { band };
        require!(band % tick == 0, BideError::StrikeOffTick);
        require!(band < target, BideError::InvalidPlanParams);
        b.strike_min = target - band;
        b.strike_max = target;
    }
    if side == Side::Sell || side == Side::Wheel {
        require!(exit > 0, BideError::ZeroAmount);
        require!(exit % tick == 0, BideError::StrikeOffTick);
        let eb = if lock { 0 } else { exit_band };
        require!(eb % tick == 0, BideError::StrikeOffTick);
        b.call_strike_min = exit;
        b.call_strike_max = exit.checked_add(eb).ok_or(BideError::MathOverflow)?;
    }
    Ok(b)
}

pub fn check_horizon(quick: bool, horizon_end: i64, now: i64) -> Result<()> {
    let min = if quick { MIN_HORIZON_SECS_QUICK } else { MIN_HORIZON_SECS_STD };
    require!(
        horizon_end >= now + min && horizon_end <= now + MAX_HORIZON_SECS,
        BideError::HorizonOutOfRange
    );
    Ok(())
}

pub fn create_plan<'info>(ctx: Context<'info, CreatePlan<'info>>, args: CreatePlanArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    let asset = &ctx.accounts.asset;
    require!(!cfg.paused, BideError::Paused);
    require!(asset.enabled, BideError::AssetDisabled);
    require!(args.size_total > 0, BideError::ZeroAmount);
    require!(args.min_premium_bps_per_day > 0, BideError::PremiumBelowUserMin);
    require!(args.max_expiry_secs > 0 && args.max_rounds_per_day > 0, BideError::InvalidPlanParams);
    check_horizon(args.quick, args.horizon_end, now)?;
    let b = validate_bounds(asset, args.side, args.target_strike, args.exit_strike, args.lock_strike, args.band, args.exit_band)?;

    // collateral
    let (collateral_mint, principal) = match args.side {
        Side::Buy | Side::Wheel => (USDC_MINT, math::notional_ceil(args.target_strike, args.size_total, asset.decimals)?),
        Side::Sell => (asset.mint, args.size_total),
    };
    require!(principal > 0, BideError::ZeroAmount);
    require_keys_eq!(ctx.accounts.collateral_mint.key(), collateral_mint, BideError::InvalidMint);

    let plan_key = ctx.accounts.plan.key();
    let lend_bump = ctx.bumps.lend_auth;
    let has_lend = lend::f_token_for_mint(&collateral_mint).is_some();
    let deposit_amount = if has_lend { principal.checked_add(LEND_DUST_BUFFER).ok_or(BideError::MathOverflow)? } else { principal };
    util::transfer(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.owner_collateral.to_account_info(),
        &ctx.accounts.vault_collateral.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        None,
        deposit_amount,
    )?;

    let shares = match lend::f_token_for_mint(&collateral_mint) {
        Some(ft) => {
            let vf = ctx.accounts.vault_f_token.as_ref().ok_or(BideError::InvalidLendAccounts)?;
            require_keys_eq!(vf.mint, ft, BideError::InvalidMint);
            require_keys_eq!(vf.owner, ctx.accounts.lend_auth.key(), BideError::InvalidAccount);
            util::require_ata(&vf.key(), &ctx.accounts.lend_auth.key(), &ft)?;
            let m = LendMarket::from_remaining(ctx.remaining_accounts, 0, &collateral_mint)?;
            let progs = LendPrograms {
                token_program: &ctx.accounts.token_program.to_account_info(),
                associated_token_program: &ctx.accounts.associated_token_program.to_account_info(),
                system_program: &ctx.accounts.system_program.to_account_info(),
            };
            let seeds: &[&[u8]] = &[SEED_LEND_AUTH, plan_key.as_ref(), &[lend_bump]];
            lend::deposit(
                &m,
                &progs,
                &ctx.accounts.lend_auth.to_account_info(),
                seeds,
                &ctx.accounts.vault_collateral.to_account_info(),
                &vf.to_account_info(),
                deposit_amount,
            )?
        }
        None => 0,
    };

    let p = &mut ctx.accounts.plan;
    p.owner = ctx.accounts.owner.key();
    p.asset = asset.key();
    p.asset_mint = asset.mint;
    p.nonce = args.nonce;
    p.side = args.side;
    p.phase = if args.side == Side::Sell { Phase::Exit } else { Phase::Accumulate };
    p.quick = args.quick;
    p.target_strike = args.target_strike;
    p.lock_strike = args.lock_strike;
    p.band = if args.lock_strike { 0 } else { args.band };
    p.strike_min = b.strike_min;
    p.strike_max = b.strike_max;
    p.exit_strike = args.exit_strike;
    p.exit_band = if args.lock_strike { 0 } else { args.exit_band };
    p.call_strike_min = b.call_strike_min;
    p.call_strike_max = b.call_strike_max;
    p.size_total = args.size_total;
    p.size_filled = 0;
    p.collateral_principal = principal;
    p.lend_shares = shares;
    p.pending_settlement = None;
    p.min_premium_bps_per_day = args.min_premium_bps_per_day;
    p.max_expiry_secs = args.max_expiry_secs;
    p.horizon_end = args.horizon_end;
    p.max_rounds_per_day = args.max_rounds_per_day;
    p.rounds_today = 0;
    p.day_index = (now / SECS_PER_DAY) as u32;
    p.round_count = 0;
    p.active_round = None;
    p.paused = false;
    p.status = PlanStatus::Active;
    p.created_at = now;
    p.bump = ctx.bumps.plan;
    p.lend_auth_bump = lend_bump;

    emit!(PlanCreated {
        plan: plan_key,
        owner: p.owner,
        asset: p.asset,
        side: args.side as u8,
        quick: args.quick,
        target_strike: args.target_strike,
        exit_strike: args.exit_strike,
        size_total: args.size_total,
        collateral_principal: principal,
        lend_shares: shares,
        horizon_end: args.horizon_end,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PausePlan<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ BideError::Unauthorized)]
    pub plan: Box<Account<'info, Plan>>,
}

pub fn pause_plan(ctx: Context<PausePlan>, paused: bool) -> Result<()> {
    ctx.accounts.plan.paused = paused;
    Ok(())
}

/// Collateral mint for the plan's current phase.
pub fn phase_collateral_mint(p: &Plan) -> Pubkey {
    match (p.side, p.phase) {
        (Side::Sell, _) | (Side::Wheel, Phase::Exit) => p.asset_mint,
        _ => USDC_MINT,
    }
}

/// close_plan / expire_plan. Remaining accounts: 13 Lend market accounts of the phase collateral mint
/// (omit if it has no Lend market).
#[derive(Accounts)]
pub struct ClosePlan<'info> {
    /// owner for close_plan; anyone for expire_plan
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut)]
    pub plan: Box<Account<'info, Plan>>,
    /// CHECK: PDA, verified by seeds
    #[account(mut, seeds = [SEED_LEND_AUTH, plan.key().as_ref()], bump = plan.lend_auth_bump)]
    pub lend_auth: UncheckedAccount<'info>,
    /// ATA(phase collateral mint, lend_auth): Lend withdrawals land here first
    #[account(mut, token::authority = lend_auth)]
    pub vault_collateral: Box<Account<'info, TokenAccount>>,
    /// ATA(fToken, lend_auth); None when the collateral has no Lend market
    #[account(mut)]
    pub vault_f_token: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: owner's token account for the collateral mint (validated in handler)
    #[account(mut)]
    pub owner_collateral: UncheckedAccount<'info>,
    /// Wheel-Accumulate only: ATA(asset, lend_auth) holding filled asset
    #[account(mut)]
    pub vault_asset: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: owner's asset token account (validated in handler); required with vault_asset
    #[account(mut)]
    pub owner_asset: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn drain_plan<'info>(ctx: &Context<'info, ClosePlan<'info>>) -> Result<(u64, u64)> {
    let p = &ctx.accounts.plan;
    require!(p.status != PlanStatus::Closed, BideError::WrongStatus);
    require!(p.pending_settlement.is_none(), BideError::SettlementPending);
    require!(p.active_round.is_none(), BideError::ActiveRoundExists);
    let plan_key = p.key();
    let lend_auth = ctx.accounts.lend_auth.to_account_info();
    let seeds: &[&[u8]] = &[SEED_LEND_AUTH, plan_key.as_ref(), &[p.lend_auth_bump]];
    let tp = ctx.accounts.token_program.to_account_info();
    let mint = phase_collateral_mint(p);
    let vc = &ctx.accounts.vault_collateral;
    require_keys_eq!(vc.mint, mint, BideError::InvalidMint);
    // canonical vaults only, checked before anything moves (a substitute empty account would otherwise let the
    // plan close while its real balances stay stranded) — including the fToken vault when its balance is 0.
    util::require_ata(&vc.key(), &lend_auth.key(), &mint)?;
    if let Some(ft) = lend::f_token_for_mint(&mint) {
        let vf = ctx.accounts.vault_f_token.as_ref().ok_or(BideError::InvalidLendAccounts)?;
        util::require_ata(&vf.key(), &lend_auth.key(), &ft)?;
    }
    if let Some(va) = ctx.accounts.vault_asset.as_ref() {
        util::require_ata(&va.key(), &lend_auth.key(), &p.asset_mint)?;
    }

    if let Some(ft) = lend::f_token_for_mint(&mint) {
        let vf = ctx.accounts.vault_f_token.as_ref().ok_or(BideError::InvalidLendAccounts)?;
        require_keys_eq!(vf.mint, ft, BideError::InvalidMint);
        require_keys_eq!(vf.owner, lend_auth.key(), BideError::InvalidAccount);
        if vf.amount > 0 {
            let m = LendMarket::from_remaining(ctx.remaining_accounts, 0, &mint)?;
            let value = lend::shares_to_assets(vf.amount, lend::token_exchange_price(m.lending())?)?;
            // dust below Lend's minimum operate amount stays in the vault (Lend would reject it)
            if value >= LEND_MIN_REDEEM_VALUE {
                let progs = LendPrograms {
                    token_program: &tp,
                    associated_token_program: &ctx.accounts.associated_token_program.to_account_info(),
                    system_program: &ctx.accounts.system_program.to_account_info(),
                };
                lend::redeem(&m, &progs, &lend_auth, seeds, &vf.to_account_info(), &vc.to_account_info(), vf.amount)?;
            }
        }
    }
    let coll_out = lend::token_amount(&vc.to_account_info())?;
    util::check_token_account(&ctx.accounts.owner_collateral, &mint, Some(&p.owner))?;
    util::transfer(&tp, &vc.to_account_info(), &ctx.accounts.owner_collateral, &lend_auth, Some(seeds), coll_out)?;

    let mut asset_out = 0;
    // Wheel in Accumulate: filled puts sit in the plan's asset vault — it must be swept too.
    if p.side == Side::Wheel && p.phase == Phase::Accumulate {
        require!(ctx.accounts.vault_asset.is_some() && ctx.accounts.owner_asset.is_some(), BideError::InvalidAccount);
    }
    if let Some(va) = ctx.accounts.vault_asset.as_ref() {
        require_keys_eq!(va.mint, p.asset_mint, BideError::InvalidMint);
        require_keys_eq!(va.owner, lend_auth.key(), BideError::InvalidAccount);
        require!(va.key() != vc.key(), BideError::InvalidAccount);
        asset_out = va.amount;
        if asset_out > 0 {
            let oa = ctx.accounts.owner_asset.as_ref().ok_or(BideError::InvalidAccount)?;
            util::check_token_account(oa, &p.asset_mint, Some(&p.owner))?;
            util::transfer(&tp, &va.to_account_info(), oa, &lend_auth, Some(seeds), asset_out)?;
        }
    }
    Ok((coll_out, asset_out))
}

fn finish_close(p: &mut Plan) {
    p.status = PlanStatus::Closed;
    p.lend_shares = 0;
    p.collateral_principal = 0;
}

pub fn close_plan<'info>(ctx: Context<'info, ClosePlan<'info>>) -> Result<()> {
    require_keys_eq!(ctx.accounts.caller.key(), ctx.accounts.plan.owner, BideError::Unauthorized);
    let (c, a) = drain_plan(&ctx)?;
    finish_close(&mut ctx.accounts.plan);
    emit!(PlanClosed { plan: ctx.accounts.plan.key(), collateral_returned: c, asset_returned: a });
    Ok(())
}

pub fn expire_plan<'info>(ctx: Context<'info, ClosePlan<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.plan.horizon_end, BideError::PlanNotExpired);
    let (c, a) = drain_plan(&ctx)?;
    finish_close(&mut ctx.accounts.plan);
    emit!(PlanExpired { plan: ctx.accounts.plan.key(), collateral_returned: c, asset_returned: a });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdatePlanArgs {
    pub target_strike: Option<u64>,
    pub band: Option<u64>,
    pub horizon_end: Option<i64>,
    pub min_premium_bps_per_day: Option<u16>,
    pub size_total: Option<u64>,
}

/// update_plan (deferred: layout frozen). Remaining: 13 Lend market accounts of the phase collateral.
#[derive(Accounts)]
pub struct UpdatePlan<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = plan.asset)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(mut, has_one = owner @ BideError::Unauthorized)]
    pub plan: Box<Account<'info, Plan>>,
    /// CHECK: PDA
    #[account(mut, seeds = [SEED_LEND_AUTH, plan.key().as_ref()], bump = plan.lend_auth_bump)]
    pub lend_auth: UncheckedAccount<'info>,
    #[account(mut, token::authority = owner)]
    pub owner_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = lend_auth)]
    pub vault_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_f_token: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Collateral the plan must hold for its remaining size in the current phase.
fn required_collateral(p: &Plan, decimals: u8) -> Result<u64> {
    let remaining = p.size_total.checked_sub(p.size_filled).ok_or(BideError::MathOverflow)?;
    match (p.side, p.phase) {
        (Side::Sell, _) | (Side::Wheel, Phase::Exit) => Ok(remaining),
        _ => math::notional_ceil(p.target_strike, remaining, decimals),
    }
}

pub fn update_plan<'info>(ctx: Context<'info, UpdatePlan<'info>>, args: UpdatePlanArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.config.paused, BideError::Paused);
    let asset = &ctx.accounts.asset;
    {
        let p = &ctx.accounts.plan;
        require!(p.status == PlanStatus::Active, BideError::WrongStatus);
        require!(p.pending_settlement.is_none(), BideError::SettlementPending);
        require!(p.active_round.is_none(), BideError::ActiveRoundExists);
    }
    let p = &mut ctx.accounts.plan;
    let exit_side = p.side == Side::Sell || (p.side == Side::Wheel && p.phase == Phase::Exit);
    // strikes: target/band apply to the side the plan is currently trading
    if args.target_strike.is_some() || args.band.is_some() {
        let (mut target, mut exit) = (p.target_strike, p.exit_strike);
        let (mut band, mut exit_band) = (p.band, p.exit_band);
        if exit_side {
            exit = args.target_strike.unwrap_or(exit);
            exit_band = args.band.unwrap_or(exit_band);
        } else {
            target = args.target_strike.unwrap_or(target);
            band = args.band.unwrap_or(band);
        }
        let b = validate_bounds(asset, p.side, target, exit, p.lock_strike, band, exit_band)?;
        p.target_strike = target;
        p.exit_strike = exit;
        p.band = if p.lock_strike { 0 } else { band };
        p.exit_band = if p.lock_strike { 0 } else { exit_band };
        p.strike_min = b.strike_min;
        p.strike_max = b.strike_max;
        p.call_strike_min = b.call_strike_min;
        p.call_strike_max = b.call_strike_max;
    }
    if let Some(h) = args.horizon_end {
        check_horizon(p.quick, h, now)?;
        p.horizon_end = h;
    }
    if let Some(m) = args.min_premium_bps_per_day {
        require!(m > 0, BideError::PremiumBelowUserMin);
        p.min_premium_bps_per_day = m;
    }
    if let Some(sz) = args.size_total {
        require!(sz > p.size_filled, BideError::ZeroAmount);
        p.size_total = sz;
    }
    // rebalance collateral
    let required = required_collateral(p, asset.decimals)?;
    let current = p.collateral_principal;
    // nothing to move (or an excess too small for Lend to process → stays as principal)
    if required == current || (required < current && current - required < LEND_MIN_REDEEM_VALUE) {
        emit!(PlanUpdated { plan: p.key() });
        return Ok(());
    }
    let mint = phase_collateral_mint(p);
    let vc = &ctx.accounts.vault_collateral;
    let oc = &ctx.accounts.owner_collateral;
    require_keys_eq!(vc.mint, mint, BideError::InvalidMint);
    require_keys_eq!(oc.mint, mint, BideError::InvalidMint);
    let plan_key = p.key();
    let seeds: &[&[u8]] = &[SEED_LEND_AUTH, plan_key.as_ref(), &[p.lend_auth_bump]];
    let lend_auth = ctx.accounts.lend_auth.to_account_info();
    let tp = ctx.accounts.token_program.to_account_info();
    util::require_ata(&vc.key(), &lend_auth.key(), &mint)?;
    let market = match lend::f_token_for_mint(&mint) {
        Some(ft) => {
            let vf = ctx.accounts.vault_f_token.as_ref().ok_or(BideError::InvalidLendAccounts)?;
            require_keys_eq!(vf.mint, ft, BideError::InvalidMint);
            require_keys_eq!(vf.owner, lend_auth.key(), BideError::InvalidAccount);
            util::require_ata(&vf.key(), &lend_auth.key(), &ft)?;
            Some((LendMarket::from_remaining(ctx.remaining_accounts, 0, &mint)?, vf.to_account_info()))
        }
        None => None,
    };
    let ata_prog = ctx.accounts.associated_token_program.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    let progs = LendPrograms { token_program: &tp, associated_token_program: &ata_prog, system_program: &sys };
    if required > current {
        let add = required - current;
        util::transfer(&tp, &oc.to_account_info(), &vc.to_account_info(), &ctx.accounts.owner.to_account_info(), None, add)?;
        if let Some((m, vf)) = market.as_ref() {
            let minted = lend::deposit(m, &progs, &lend_auth, seeds, &vc.to_account_info(), vf, add)?;
            p.lend_shares = p.lend_shares.checked_add(minted).ok_or(BideError::MathOverflow)?;
        }
    } else {
        let out = current - required;
        if let Some((m, vf)) = market.as_ref() {
            let (_, burned) = lend::withdraw(m, &progs, &lend_auth, seeds, vf, &vc.to_account_info(), out)?;
            p.lend_shares = p.lend_shares.saturating_sub(burned);
        }
        util::transfer(&tp, &vc.to_account_info(), &oc.to_account_info(), &lend_auth, Some(seeds), out)?;
    }
    p.collateral_principal = required;
    emit!(PlanUpdated { plan: plan_key });
    Ok(())
}

/// flip_plan (deferred: layout frozen). Remaining: 13 USDC Lend market accounts, then 13 asset Lend market accounts.
#[derive(Accounts)]
pub struct FlipPlan<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.agent == agent.key() @ BideError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub plan: Box<Account<'info, Plan>>,
    /// CHECK: PDA
    #[account(mut, seeds = [SEED_LEND_AUTH, plan.key().as_ref()], bump = plan.lend_auth_bump)]
    pub lend_auth: UncheckedAccount<'info>,
    #[account(mut, token::authority = lend_auth)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = lend_auth)]
    pub vault_usdc_f_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: owner's USDC account (validated in handler)
    #[account(mut)]
    pub owner_usdc: UncheckedAccount<'info>,
    #[account(mut, token::authority = lend_auth)]
    pub vault_asset: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_asset_f_token: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Wheel: Accumulate → Exit. Remaining: 13 USDC Lend market accounts, then 13 asset Lend market accounts
/// (omit the second set for a no-Lend asset).
pub fn flip_plan<'info>(ctx: Context<'info, FlipPlan<'info>>) -> Result<()> {
    let p = &ctx.accounts.plan;
    require!(!ctx.accounts.config.paused, BideError::Paused);
    require!(p.side == Side::Wheel, BideError::NotWheelPlan);
    require!(p.phase == Phase::Accumulate, BideError::WrongPhase);
    require!(p.status == PlanStatus::Active, BideError::WrongStatus);
    require!(p.size_filled == p.size_total, BideError::WrongPhase);
    require!(p.active_round.is_none(), BideError::ActiveRoundExists);
    require!(p.pending_settlement.is_none(), BideError::SettlementPending);
    let plan_key = p.key();
    let seeds: &[&[u8]] = &[SEED_LEND_AUTH, plan_key.as_ref(), &[p.lend_auth_bump]];
    let lend_auth = ctx.accounts.lend_auth.to_account_info();
    let tp = ctx.accounts.token_program.to_account_info();
    let ata_prog = ctx.accounts.associated_token_program.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    let progs = LendPrograms { token_program: &tp, associated_token_program: &ata_prog, system_program: &sys };

    // 1) all remaining USDC (unused collateral + yield) → owner
    let vu = &ctx.accounts.vault_usdc;
    let vuf = &ctx.accounts.vault_usdc_f_token;
    require_keys_eq!(vu.mint, USDC_MINT, BideError::InvalidMint);
    require_keys_eq!(vuf.mint, LEND_USDC_FTOKEN, BideError::InvalidMint);
    // canonical plan vaults only (USDC, USDC fToken, asset, asset fToken), checked before anything moves
    util::require_ata(&vu.key(), &lend_auth.key(), &USDC_MINT)?;
    util::require_ata(&vuf.key(), &lend_auth.key(), &LEND_USDC_FTOKEN)?;
    util::require_ata(&ctx.accounts.vault_asset.key(), &lend_auth.key(), &p.asset_mint)?;
    if let Some(ft) = lend::f_token_for_mint(&p.asset_mint) {
        let vaf = ctx.accounts.vault_asset_f_token.as_ref().ok_or(BideError::InvalidLendAccounts)?;
        util::require_ata(&vaf.key(), &lend_auth.key(), &ft)?;
    }
    let usdc_m = LendMarket::from_remaining(ctx.remaining_accounts, 0, &USDC_MINT)?;
    if vuf.amount > 0 {
        let value = lend::shares_to_assets(vuf.amount, lend::token_exchange_price(usdc_m.lending())?)?;
        if value >= LEND_MIN_REDEEM_VALUE {
            lend::redeem(&usdc_m, &progs, &lend_auth, seeds, &vuf.to_account_info(), &vu.to_account_info(), vuf.amount)?;
        }
    }
    util::check_token_account(&ctx.accounts.owner_usdc, &USDC_MINT, Some(&p.owner))?;
    let usdc_out = lend::token_amount(&vu.to_account_info())?;
    util::transfer(&tp, &vu.to_account_info(), &ctx.accounts.owner_usdc, &lend_auth, Some(seeds), usdc_out)?;

    // 2) asset vault → asset Lend market (if any)
    let va = &ctx.accounts.vault_asset;
    require_keys_eq!(va.mint, p.asset_mint, BideError::InvalidMint);
    let held = va.amount;
    require!(held > 0, BideError::ZeroAmount);
    let mut shares = 0u64;
    let mut size = held;
    if let Some(ft) = lend::f_token_for_mint(&p.asset_mint) {
        let vaf = ctx.accounts.vault_asset_f_token.as_ref().ok_or(BideError::InvalidLendAccounts)?;
        require_keys_eq!(vaf.mint, ft, BideError::InvalidMint);
        require_keys_eq!(vaf.owner, lend_auth.key(), BideError::InvalidAccount);
        let am = LendMarket::from_remaining(ctx.remaining_accounts, lend::LEND_MARKET_ACCOUNTS, &p.asset_mint)?;
        shares = lend::deposit(&am, &progs, &lend_auth, seeds, &va.to_account_info(), &vaf.to_account_info(), held)?;
        // keep a dust buffer so withdraw-by-amount of `size` never comes up 1 unit short
        size = held.saturating_sub(LEND_DUST_BUFFER);
        require!(size > 0, BideError::ZeroAmount);
    }
    let p = &mut ctx.accounts.plan;
    p.lend_shares = shares;
    p.collateral_principal = size;
    p.size_total = size;
    p.size_filled = 0;
    p.phase = Phase::Exit;
    emit!(PlanFlipped { plan: plan_key, size_total: size, lend_shares: shares });
    Ok(())
}
