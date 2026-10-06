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
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Token, TokenAccount},
};

use super::round::round_seeds_close;

#[derive(Accounts)]
#[instruction(kind: EpochKind, expiry: i64)]
pub struct OpenEpoch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_ASSET, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(
        init, payer = payer, space = 8 + Epoch::INIT_SPACE,
        seeds = [SEED_EPOCH, asset.key().as_ref(), &[kind as u8], &expiry.to_le_bytes()], bump
    )]
    pub epoch: Box<Account<'info, Epoch>>,
    pub system_program: Program<'info, System>,
}

pub fn open_epoch(ctx: Context<OpenEpoch>, kind: EpochKind, expiry: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expiry > now && expiry <= now + MAX_HORIZON_SECS, BideError::InvalidSchedule);
    let e = &mut ctx.accounts.epoch;
    match kind {
        EpochKind::Std => {
            require!(expiry.rem_euclid(SECS_PER_DAY) == STD_EXPIRY_TOD_SECS, BideError::InvalidSchedule);
            e.n_buckets = STD_N_BUCKETS;
            e.bucket_secs = STD_BUCKET_SECS;
            e.bucket_tolerance_secs = STD_BUCKET_TOLERANCE_SECS;
            e.grace_secs = STD_GRACE_SECS;
        }
        EpochKind::Quick => {
            require!(expiry.rem_euclid(QUICK_EPOCH_SECS) == 0, BideError::InvalidSchedule);
            e.n_buckets = QUICK_N_BUCKETS;
            e.bucket_secs = QUICK_BUCKET_SECS;
            e.bucket_tolerance_secs = QUICK_BUCKET_TOLERANCE_SECS;
            e.grace_secs = QUICK_GRACE_SECS;
        }
    }
    e.asset = ctx.accounts.asset.key();
    e.kind = kind;
    e.expiry = expiry;
    e.samples = [0; 10];
    e.sample_mask = 0;
    e.settle_price = 0;
    e.status = EpochStatus::Open;
    e.bump = ctx.bumps.epoch;
    emit!(EpochOpened { epoch: e.key(), asset: e.asset, kind: kind as u8, expiry });
    Ok(())
}

#[derive(Accounts)]
pub struct PostSample<'info> {
    #[account(address = epoch.asset)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(mut)]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: PriceUpdateV2 owned by the Pyth receiver (validated in oracle::load_price_update)
    pub price_update: UncheckedAccount<'info>,
}

pub fn post_sample(ctx: Context<PostSample>, bucket: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let asset = &ctx.accounts.asset;
    let e = &mut ctx.accounts.epoch;
    require!(
        e.status == EpochStatus::Open || e.status == EpochStatus::Sampling,
        BideError::EpochNotOpen
    );
    require!(now <= e.expiry + e.grace_secs as i64, BideError::EpochNotOpen);
    require!(bucket < e.n_buckets, BideError::BucketOutOfRange);
    require!(e.sample_mask & (1u16 << bucket) == 0, BideError::BucketFilled);
    let pu = oracle::load_price_update(&ctx.accounts.price_update)?;
    let m = &pu.price_message;
    require!(m.feed_id == asset.pyth_feed_id, BideError::WrongFeed);
    let bstart = super::round::window_start(e) + (bucket as i64) * (e.bucket_secs as i64);
    // unique sample per bucket: the first update at/after bucket start (P2 rule, notes/oracle.md §2)
    let in_bucket = m.prev_publish_time < bstart
        && m.publish_time >= bstart
        && m.publish_time <= bstart + e.bucket_tolerance_secs as i64;
    require!(in_bucket, BideError::SampleOutsideBucket);
    require!(math::conf_ok(m.price, m.conf, asset.max_conf_bps), BideError::PriceConfidenceTooWide);
    let price = math::pyth_to_usdc(m.price, m.exponent)?;
    e.samples[bucket as usize] = price;
    e.sample_mask |= 1u16 << bucket;
    e.status = EpochStatus::Sampling;
    emit!(SamplePosted { epoch: e.key(), bucket, price, publish_time: m.publish_time });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveEpoch<'info> {
    #[account(mut)]
    pub epoch: Box<Account<'info, Epoch>>,
}

pub fn resolve_epoch(ctx: Context<ResolveEpoch>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.epoch;
    require!(
        e.status == EpochStatus::Open || e.status == EpochStatus::Sampling,
        BideError::WrongStatus
    );
    let n = e.n_buckets;
    let filled = math::count_mask(e.sample_mask, n);
    let closed = now >= e.expiry + e.grace_secs as i64;
    let ok = (filled == n && now >= e.expiry) || (filled + 2 >= n && filled > 0 && closed);
    if ok {
        let px = math::median(&e.samples, e.sample_mask, n).ok_or(BideError::NotEnoughSamples)?;
        e.settle_price = px;
        e.status = EpochStatus::Resolved;
        emit!(EpochResolved { epoch: e.key(), settle_price: px, n_samples: filled });
    } else if closed {
        e.status = EpochStatus::Failed;
        emit!(EpochFailed { epoch: e.key(), n_samples: filled });
    } else {
        return err!(BideError::NotEnoughSamples);
    }
    Ok(())
}

fn plan_lend_auth(plan: &Account<Plan>) -> Result<Pubkey> {
    Pubkey::create_program_address(
        &[SEED_LEND_AUTH, plan.key().as_ref(), &[plan.lend_auth_bump]],
        &crate::ID,
    )
    .map_err(|_| error!(BideError::InvalidAccount))
}

fn pool_lend_auth(pool: &Account<Pool>) -> Result<Pubkey> {
    Pubkey::create_program_address(&[SEED_LEND_AUTH, pool.key().as_ref(), &[pool.lend_auth_bump]], &crate::ID)
        .map_err(|_| error!(BideError::InvalidAccount))
}

fn escrow_mint(r: &Round, asset_mint: &Pubkey) -> Pubkey {
    if r.kind == RoundKind::Put { *asset_mint } else { USDC_MINT }
}

/// Validate the maker-side destination (maker's own account, or pool vault) for the escrow mint.
fn check_maker_dest(r: &Round, pool: &Option<Box<Account<Pool>>>, dest: &AccountInfo, mint: &Pubkey) -> Result<()> {
    if r.maker_is_pool {
        let pool = pool.as_ref().ok_or(BideError::InvalidAccount)?;
        util::check_token_account(dest, mint, Some(&pool_lend_auth(pool)?))?;
    } else {
        util::check_token_account(dest, mint, Some(&r.maker))?;
    }
    Ok(())
}

/// Release the pool's escrow reservation. If the round was exercised, the escrow went to the user and the pool is
/// owed the other leg (Put: notional USDC, Call: size asset) by withdraw_collateral — book it as a receivable in
/// reserved_* so pool NAV doesn't dip between resolve_round and withdraw_collateral.
fn release_pool(r: &Round, pool: &mut Option<Box<Account<Pool>>>, exercised: bool) -> Result<()> {
    if !r.maker_is_pool {
        return Ok(());
    }
    let pool = pool.as_mut().ok_or(BideError::InvalidAccount)?;
    pool.open_notional = pool.open_notional.saturating_sub(r.notional);
    match r.kind {
        RoundKind::Put => {
            pool.reserved_wsol = pool.reserved_wsol.saturating_sub(r.size);
            if exercised {
                pool.reserved_usdc = pool.reserved_usdc.checked_add(r.notional).ok_or(BideError::MathOverflow)?;
            }
        }
        RoundKind::Call => {
            pool.reserved_usdc = pool.reserved_usdc.saturating_sub(r.notional);
            if exercised {
                pool.reserved_wsol = pool.reserved_wsol.checked_add(r.size).ok_or(BideError::MathOverflow)?;
            }
        }
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveRound<'info> {
    #[account(mut, address = round.plan)]
    pub plan: Box<Account<'info, Plan>>,
    #[account(mut)]
    pub round: Box<Account<'info, Round>>,
    #[account(address = round.epoch)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [SEED_ESCROW, round.key().as_ref()], bump = round.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: exercised destination — Put: owner's asset account (Wheel: ATA(asset, plan lend_auth));
    /// Call: owner's USDC account. Validated.
    #[account(mut)]
    pub user_dest: UncheckedAccount<'info>,
    /// CHECK: not-exercised destination — maker's (or pool vault's) account of the escrow mint. Validated.
    #[account(mut)]
    pub maker_dest: UncheckedAccount<'info>,
    /// CHECK: rent refund
    #[account(mut, address = round.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Option<Box<Account<'info, Pool>>>,
    pub token_program: Program<'info, Token>,
}

pub fn resolve_round(ctx: Context<ResolveRound>) -> Result<()> {
    let r = &ctx.accounts.round;
    let e = &ctx.accounts.epoch;
    require!(r.status == RoundStatus::Live, BideError::WrongStatus);
    require!(e.status != EpochStatus::Failed, BideError::EpochFailed);
    require!(e.status == EpochStatus::Resolved, BideError::EpochNotResolved);
    let px = e.settle_price;
    let exercised = match r.kind {
        RoundKind::Put => px < r.strike,
        RoundKind::Call => px > r.strike,
    };
    let plan = &ctx.accounts.plan;
    let emint = escrow_mint(r, &plan.asset_mint);
    let tp = ctx.accounts.token_program.to_account_info();
    let idx = r.round_index.to_le_bytes();
    let rseeds: &[&[u8]] = &[SEED_ROUND, r.plan.as_ref(), &idx, &[r.bump]];
    let escrow = ctx.accounts.escrow.to_account_info();
    let amount = ctx.accounts.escrow.amount;
    let round_ai = ctx.accounts.round.to_account_info();

    if exercised {
        let want_owner = if r.kind == RoundKind::Put && plan.side == Side::Wheel {
            plan_lend_auth(plan)?
        } else {
            plan.owner
        };
        util::check_token_account(&ctx.accounts.user_dest, &emint, Some(&want_owner))?;
        util::transfer(&tp, &escrow, &ctx.accounts.user_dest, &round_ai, Some(rseeds), amount)?;
    } else {
        check_maker_dest(r, &ctx.accounts.pool, &ctx.accounts.maker_dest, &emint)?;
        util::transfer(&tp, &escrow, &ctx.accounts.maker_dest, &round_ai, Some(rseeds), amount)?;
    }
    round_seeds_close(&tp, &ctx.accounts.round, &escrow, &ctx.accounts.rent_payer.to_account_info())?;

    let r_copy = (*ctx.accounts.round).clone();
    release_pool(&r_copy, &mut ctx.accounts.pool, exercised)?;

    let round_key = ctx.accounts.round.key();
    let plan = &mut ctx.accounts.plan;
    if plan.active_round == Some(round_key) {
        plan.active_round = None;
    }
    let r = &mut ctx.accounts.round;
    r.settle_price = px;
    r.status = RoundStatus::Resolved;
    if exercised {
        r.exercised = EXERCISED_YES;
        plan.size_filled = plan.size_filled.checked_add(r.size).ok_or(BideError::MathOverflow)?;
        plan.pending_settlement = Some(round_key);
        if plan.size_filled >= plan.size_total && plan.side != Side::Wheel {
            plan.status = PlanStatus::Filled;
        }
    } else {
        r.exercised = EXERCISED_NO;
        // close the Round now (rent → rent_payer)
        r.close(ctx.accounts.rent_payer.to_account_info())?;
    }
    emit!(RoundResolved { round: round_key, plan: plan.key(), settle_price: px, exercised });
    Ok(())
}

/// withdraw_collateral. Remaining accounts: 13 Lend market accounts of the staging mint
/// (USDC for a Put, the asset for a Call; omit for a no-Lend asset).
#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, address = round.plan)]
    pub plan: Box<Account<'info, Plan>>,
    #[account(mut)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: PDA
    #[account(mut, seeds = [SEED_LEND_AUTH, plan.key().as_ref()], bump = plan.lend_auth_bump)]
    pub lend_auth: UncheckedAccount<'info>,
    /// ATA(USDC (Put) | asset (Call), lend_auth)
    #[account(mut, token::authority = lend_auth)]
    pub vault_staging: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub vault_f_token: Option<Box<Account<'info, TokenAccount>>>,
    /// CHECK: counterparty (maker or pool vault) account of the staging mint — validated
    #[account(mut)]
    pub counterparty_dest: UncheckedAccount<'info>,
    /// CHECK: rent refund
    #[account(mut, address = round.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Option<Box<Account<'info, Pool>>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn withdraw_collateral<'info>(ctx: Context<'info, WithdrawCollateral<'info>>) -> Result<()> {
    let r = &ctx.accounts.round;
    let plan = &ctx.accounts.plan;
    require!(r.status == RoundStatus::Resolved && r.exercised == EXERCISED_YES, BideError::WrongStatus);
    require!(plan.pending_settlement == Some(r.key()), BideError::WrongStatus);
    let (mint, owed) = match r.kind {
        RoundKind::Put => (USDC_MINT, r.notional),
        RoundKind::Call => (plan.asset_mint, r.size),
    };
    let vs = &ctx.accounts.vault_staging;
    require_keys_eq!(vs.mint, mint, BideError::InvalidMint);
    check_maker_dest(r, &ctx.accounts.pool, &ctx.accounts.counterparty_dest, &mint)?;

    let plan_key = plan.key();
    let seeds: &[&[u8]] = &[SEED_LEND_AUTH, plan_key.as_ref(), &[plan.lend_auth_bump]];
    let lend_auth = ctx.accounts.lend_auth.to_account_info();
    let tp = ctx.accounts.token_program.to_account_info();
    let staged_before = vs.amount;
    let mut burned = 0u64;

    if let Some(ft) = lend::f_token_for_mint(&mint) {
        let vf = ctx.accounts.vault_f_token.as_ref().ok_or(BideError::InvalidLendAccounts)?;
        require_keys_eq!(vf.mint, ft, BideError::InvalidMint);
        require_keys_eq!(vf.owner, lend_auth.key(), BideError::InvalidAccount);
        let m = LendMarket::from_remaining(ctx.remaining_accounts, 0, &mint)?;
        let progs = LendPrograms {
            token_program: &tp,
            associated_token_program: &ctx.accounts.associated_token_program.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
        };
        let need = owed.saturating_sub(staged_before);
        if need > 0 {
            lend::update_rate(&m)?;
            let px = lend::token_exchange_price(m.lending())?;
            let available = lend::shares_to_assets(vf.amount, px)?;
            // Lend rejects near-zero operations (6028): never withdraw less than LEND_MIN_REDEEM_VALUE;
            // the surplus stays in vault_staging and is swept to the owner by close/expire.
            let take = need.max(LEND_MIN_REDEEM_VALUE);
            let (_, b) = if available >= take {
                lend::withdraw(&m, &progs, &lend_auth, seeds, &vf.to_account_info(), &vs.to_account_info(), take)?
            } else {
                // shortfall (rounding): redeem everything the plan holds and pay what we have
                lend::redeem(&m, &progs, &lend_auth, seeds, &vf.to_account_info(), &vs.to_account_info(), vf.amount)?
            };
            burned = b;
        }
    }
    let staged = lend::token_amount(&vs.to_account_info())?;
    let paid = owed.min(staged);
    util::transfer(&tp, &vs.to_account_info(), &ctx.accounts.counterparty_dest, &lend_auth, Some(seeds), paid)?;

    // pool receivable booked in resolve_round is now settled
    if r.maker_is_pool {
        let kind = r.kind;
        let pool = ctx.accounts.pool.as_mut().ok_or(BideError::InvalidAccount)?;
        match kind {
            RoundKind::Put => pool.reserved_usdc = pool.reserved_usdc.saturating_sub(owed),
            RoundKind::Call => pool.reserved_wsol = pool.reserved_wsol.saturating_sub(owed),
        }
    }
    let r = &ctx.accounts.round;
    let round_key = r.key();
    let plan = &mut ctx.accounts.plan;
    plan.lend_shares = plan.lend_shares.saturating_sub(burned);
    plan.collateral_principal = plan.collateral_principal.saturating_sub(owed);
    plan.pending_settlement = None;
    let r = &mut ctx.accounts.round;
    r.status = RoundStatus::Settled;
    r.close(ctx.accounts.rent_payer.to_account_info())?;
    emit!(CollateralWithdrawn { round: round_key, plan: plan_key, owed, paid, shares_burned: burned });
    Ok(())
}

#[derive(Accounts)]
pub struct UnwindRound<'info> {
    #[account(mut, address = round.plan)]
    pub plan: Box<Account<'info, Plan>>,
    #[account(mut, close = rent_payer)]
    pub round: Box<Account<'info, Round>>,
    #[account(address = round.epoch)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [SEED_ESCROW, round.key().as_ref()], bump = round.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: maker's (or pool vault's) account of the escrow mint — validated
    #[account(mut)]
    pub maker_dest: UncheckedAccount<'info>,
    /// CHECK: rent refund
    #[account(mut, address = round.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Option<Box<Account<'info, Pool>>>,
    pub token_program: Program<'info, Token>,
}

pub fn unwind_round(ctx: Context<UnwindRound>) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(r.status == RoundStatus::Live, BideError::WrongStatus);
    require!(ctx.accounts.epoch.status == EpochStatus::Failed, BideError::WrongStatus);
    let emint = escrow_mint(r, &ctx.accounts.plan.asset_mint);
    check_maker_dest(r, &ctx.accounts.pool, &ctx.accounts.maker_dest, &emint)?;
    let tp = ctx.accounts.token_program.to_account_info();
    let idx = r.round_index.to_le_bytes();
    let rseeds: &[&[u8]] = &[SEED_ROUND, r.plan.as_ref(), &idx, &[r.bump]];
    let escrow = ctx.accounts.escrow.to_account_info();
    util::transfer(&tp, &escrow, &ctx.accounts.maker_dest, &ctx.accounts.round.to_account_info(), Some(rseeds), ctx.accounts.escrow.amount)?;
    round_seeds_close(&tp, &ctx.accounts.round, &escrow, &ctx.accounts.rent_payer.to_account_info())?;
    let r_copy = (*ctx.accounts.round).clone();
    release_pool(&r_copy, &mut ctx.accounts.pool, false)?;
    let round_key = ctx.accounts.round.key();
    let plan = &mut ctx.accounts.plan;
    if plan.active_round == Some(round_key) {
        plan.active_round = None;
    }
    ctx.accounts.round.status = RoundStatus::Unwound;
    emit!(RoundUnwound { round: round_key, plan: plan.key() });
    Ok(())
}
