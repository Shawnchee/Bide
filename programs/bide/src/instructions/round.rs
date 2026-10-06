use crate::{constants::*, errors::BideError, events::*, math, oracle, state::*, util};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenRoundArgs {
    pub round_index: u32,
    pub strike: u64,
    pub size: u64,
    pub auction_secs: u32,
    pub premium_start: u64,
    pub premium_floor: u64,
    pub memo_hash: [u8; 32],
}

#[derive(Accounts)]
#[instruction(args: OpenRoundArgs)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.agent == agent.key() @ BideError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = plan.asset)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(mut)]
    pub plan: Box<Account<'info, Plan>>,
    #[account(has_one = asset)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        init, payer = agent, space = 8 + Round::INIT_SPACE,
        seeds = [SEED_ROUND, plan.key().as_ref(), &args.round_index.to_le_bytes()], bump
    )]
    pub round: Box<Account<'info, Round>>,
    /// asset mint for a Put, USDC for a Call
    pub escrow_mint: Box<Account<'info, Mint>>,
    #[account(
        init, payer = agent, seeds = [SEED_ESCROW, round.key().as_ref()], bump,
        token::mint = escrow_mint, token::authority = round
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: Pyth push feed, validated against asset.spot_feed in oracle::read_spot
    pub spot_feed: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn round_kind_for(p: &Plan) -> RoundKind {
    match (p.side, p.phase) {
        (Side::Buy, _) | (Side::Wheel, Phase::Accumulate) => RoundKind::Put,
        _ => RoundKind::Call,
    }
}

pub fn window_start(e: &Epoch) -> i64 {
    e.expiry - (e.n_buckets as i64) * (e.bucket_secs as i64)
}

pub fn open_round(ctx: Context<OpenRound>, args: OpenRoundArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    let asset = &ctx.accounts.asset;
    let epoch = &ctx.accounts.epoch;
    let plan = &mut ctx.accounts.plan;

    require!(!cfg.paused, BideError::Paused);
    require!(asset.enabled, BideError::AssetDisabled);
    require!(plan.status == PlanStatus::Active, BideError::WrongStatus);
    require!(!plan.paused, BideError::PlanPaused);
    require!(plan.pending_settlement.is_none(), BideError::SettlementPending);
    require!(plan.active_round.is_none(), BideError::ActiveRoundExists);
    require!(args.round_index == plan.round_count, BideError::WrongStatus);

    let kind = round_kind_for(plan);
    let escrow_mint = if kind == RoundKind::Put { asset.mint } else { USDC_MINT };
    require_keys_eq!(ctx.accounts.escrow_mint.key(), escrow_mint, BideError::InvalidMint);

    // strike
    require!(args.strike % asset.strike_tick == 0, BideError::StrikeOffTick);
    let (lo, hi) = if kind == RoundKind::Put {
        (plan.strike_min, plan.strike_max)
    } else {
        (plan.call_strike_min, plan.call_strike_max)
    };
    require!(args.strike >= lo && args.strike <= hi && args.strike > 0, BideError::StrikeOutOfBounds);
    // size
    require!(args.size > 0, BideError::ZeroAmount);
    let remaining = plan.size_total.checked_sub(plan.size_filled).ok_or(BideError::MathOverflow)?;
    require!(args.size <= remaining, BideError::SizeTooLarge);

    // epoch
    require!(epoch.status == EpochStatus::Open, BideError::EpochNotOpen);
    let want = if plan.quick { EpochKind::Quick } else { EpochKind::Std };
    require!(epoch.kind == want, BideError::EpochKindMismatch);
    let pool_delay = match epoch.kind {
        EpochKind::Std => {
            let tod = (now - STD_EXPIRY_TOD_SECS).rem_euclid(SECS_PER_DAY);
            require!(tod < STD_AUCTION_WINDOW_SECS, BideError::OutsideAuctionWindow);
            require!(
                args.auction_secs >= STD_AUCTION_SECS_MIN && args.auction_secs <= STD_AUCTION_SECS_MAX,
                BideError::AuctionParamsInvalid
            );
            STD_POOL_DELAY_SECS
        }
        EpochKind::Quick => {
            require!(
                now >= epoch.expiry - QUICK_EPOCH_SECS && now <= epoch.expiry - QUICK_EPOCH_SECS + QUICK_AUCTION_WINDOW_SECS,
                BideError::OutsideAuctionWindow
            );
            require!(
                args.auction_secs >= QUICK_AUCTION_SECS_MIN && args.auction_secs <= QUICK_AUCTION_SECS_MAX,
                BideError::AuctionParamsInvalid
            );
            QUICK_POOL_DELAY_SECS
        }
    };
    // expiry bounds (user)
    let max_exp = now
        .checked_add(plan.max_expiry_secs as i64)
        .ok_or(BideError::MathOverflow)?
        .min(plan.horizon_end);
    require!(epoch.expiry > now && epoch.expiry <= max_exp, BideError::ExpiryOutOfBounds);
    if epoch.kind == EpochKind::Std {
        require!(epoch.expiry - now >= STD_MIN_SECS_TO_EXPIRY, BideError::ExpiryOutOfBounds);
    }
    let auction_end = now + (args.auction_secs as i64) + (pool_delay as i64);
    require!(auction_end < window_start(epoch), BideError::AuctionParamsInvalid);

    // rate limit
    let day = (now / SECS_PER_DAY) as u32;
    if day != plan.day_index {
        plan.day_index = day;
        plan.rounds_today = 0;
    }
    require!(plan.rounds_today < plan.max_rounds_per_day, BideError::RateLimited);

    // premium
    require!(args.premium_floor > 0, BideError::AuctionParamsInvalid);
    let start_cap = (args.premium_floor as u128) * 3;
    let start_ok = args.premium_floor <= args.premium_start && (args.premium_start as u128) <= start_cap;
    require!(start_ok, BideError::AuctionParamsInvalid);
    let notional = math::notional_floor(args.strike, args.size, asset.decimals)?;
    require!(notional >= MIN_ROUND_NOTIONAL, BideError::RoundTooSmall);
    require!(
        math::premium_meets_min(args.premium_floor, cfg.fee_bps, notional, plan.min_premium_bps_per_day, epoch.expiry - now)?,
        BideError::PremiumBelowUserMin
    );

    // spot
    let spot = oracle::read_spot(asset, &ctx.accounts.spot_feed, now)?;

    plan.rounds_today += 1;
    plan.round_count += 1;
    plan.active_round = Some(ctx.accounts.round.key());

    let r = &mut ctx.accounts.round;
    r.plan = plan.key();
    r.asset = asset.key();
    r.round_index = args.round_index;
    r.kind = kind;
    r.strike = args.strike;
    r.size = args.size;
    r.notional = notional;
    r.epoch = epoch.key();
    r.expiry = epoch.expiry;
    r.auction_start = now;
    r.auction_secs = args.auction_secs;
    r.pool_delay_secs = pool_delay;
    r.rent_payer = ctx.accounts.agent.key();
    r.premium_start = args.premium_start;
    r.premium_floor = args.premium_floor;
    r.spot_at_open = spot;
    r.maker = Pubkey::default();
    r.maker_is_pool = false;
    r.premium_paid = 0;
    r.fee_paid = 0;
    r.exercised = EXERCISED_UNKNOWN;
    r.settle_price = 0;
    r.memo_hash = args.memo_hash;
    r.status = RoundStatus::Auction;
    r.bump = ctx.bumps.round;
    r.escrow_bump = ctx.bumps.escrow;

    emit!(RoundOpened {
        round: r.key(),
        plan: r.plan,
        epoch: r.epoch,
        kind: kind as u8,
        strike: r.strike,
        size: r.size,
        notional,
        expiry: r.expiry,
        premium_start: r.premium_start,
        premium_floor: r.premium_floor,
        spot_at_open: spot,
        memo_hash: r.memo_hash,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct TakeRound<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = round.asset)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(address = round.plan)]
    pub plan: Box<Account<'info, Plan>>,
    #[account(mut)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [SEED_ESCROW, round.key().as_ref()], bump = round.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: Pyth push feed (validated)
    pub spot_feed: UncheckedAccount<'info>,
    /// CHECK: maker's USDC token account (pays premium; Call escrow source) — validated
    #[account(mut)]
    pub maker_usdc: UncheckedAccount<'info>,
    /// CHECK: maker's asset token account (Put escrow source) — required for Puts, validated
    #[account(mut)]
    pub maker_asset: Option<UncheckedAccount<'info>>,
    /// CHECK: plan owner's USDC token account (premium net of fee) — validated
    #[account(mut)]
    pub owner_usdc: UncheckedAccount<'info>,
    /// CHECK: fee_recipient's USDC token account — validated
    #[account(mut)]
    pub fee_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn spot_guard(asset: &Asset, round: &Round, feed: &AccountInfo, now: i64) -> Result<()> {
    let spot = oracle::read_spot(asset, feed, now)?;
    require!(
        math::within_bps(spot, round.spot_at_open, round.spot_at_open, asset.max_spot_move_bps),
        BideError::SpotMovedTooMuch
    );
    Ok(())
}

pub fn pay_premium<'info>(
    tp: &AccountInfo<'info>,
    cfg: &Config,
    plan: &Plan,
    from: &AccountInfo<'info>,
    from_auth: &AccountInfo<'info>,
    seeds: Option<&[&[u8]]>,
    owner_usdc: &AccountInfo<'info>,
    fee_usdc: &AccountInfo<'info>,
    premium: u64,
) -> Result<u64> {
    util::check_token_account(owner_usdc, &USDC_MINT, Some(&plan.owner))?;
    util::check_token_account(fee_usdc, &USDC_MINT, Some(&cfg.fee_recipient))?;
    let fee = math::mul_div_floor(premium, cfg.fee_bps as u64, BPS)?;
    util::transfer(tp, from, fee_usdc, from_auth, seeds, fee)?;
    util::transfer(tp, from, owner_usdc, from_auth, seeds, premium - fee)?;
    Ok(fee)
}

pub fn take_round(ctx: Context<TakeRound>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    let r = &ctx.accounts.round;
    require!(!cfg.paused, BideError::Paused);
    require!(r.status == RoundStatus::Auction, BideError::WrongStatus);
    require!(
        now <= r.auction_start + r.auction_secs as i64 + r.pool_delay_secs as i64,
        BideError::AuctionOver
    );
    spot_guard(&ctx.accounts.asset, r, &ctx.accounts.spot_feed, now)?;
    let premium = math::auction_price(r.premium_start, r.premium_floor, r.auction_start, r.auction_secs, now)?;

    let tp = ctx.accounts.token_program.to_account_info();
    let maker = ctx.accounts.maker.to_account_info();
    util::check_token_account(&ctx.accounts.maker_usdc, &USDC_MINT, Some(&maker.key()))?;
    let fee = pay_premium(
        &tp,
        cfg,
        &ctx.accounts.plan,
        &ctx.accounts.maker_usdc,
        &maker,
        None,
        &ctx.accounts.owner_usdc,
        &ctx.accounts.fee_usdc,
        premium,
    )?;
    let escrow = ctx.accounts.escrow.to_account_info();
    match r.kind {
        RoundKind::Put => {
            let src = ctx.accounts.maker_asset.as_ref().ok_or(BideError::InvalidAccount)?;
            util::check_token_account(src, &ctx.accounts.asset.mint, Some(&maker.key()))?;
            util::transfer(&tp, src, &escrow, &maker, None, r.size)?;
        }
        RoundKind::Call => {
            util::transfer(&tp, &ctx.accounts.maker_usdc, &escrow, &maker, None, r.notional)?;
        }
    }
    let r = &mut ctx.accounts.round;
    r.maker = maker.key();
    r.maker_is_pool = false;
    r.premium_paid = premium;
    r.fee_paid = fee;
    r.status = RoundStatus::Live;
    emit!(RoundTaken { round: r.key(), plan: r.plan, maker: r.maker, premium, fee, is_pool: false });
    Ok(())
}

/// pool_take_round (deferred: layout frozen).
#[derive(Accounts)]
pub struct PoolTakeRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = round.asset)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(address = round.plan)]
    pub plan: Box<Account<'info, Plan>>,
    #[account(mut)]
    pub round: Box<Account<'info, Round>>,
    #[account(address = round.epoch)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [SEED_ESCROW, round.key().as_ref()], bump = round.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: Pyth push feed (validated)
    pub spot_feed: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_POOL], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA
    #[account(seeds = [SEED_LEND_AUTH, pool.key().as_ref()], bump = pool.lend_auth_bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(mut, token::mint = USDC_MINT, token::authority = pool_auth)]
    pub pool_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = WSOL_MINT, token::authority = pool_auth)]
    pub pool_wsol: Box<Account<'info, TokenAccount>>,
    /// CHECK: Lend USDC `lending` account (exchange price for NAV)
    #[account(address = LEND_USDC_LENDING)]
    pub lending_usdc: UncheckedAccount<'info>,
    /// CHECK: validated
    #[account(mut)]
    pub owner_usdc: UncheckedAccount<'info>,
    /// CHECK: validated
    #[account(mut)]
    pub fee_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn pool_take_round(ctx: Context<PoolTakeRound>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    let r = &ctx.accounts.round;
    let pool = &ctx.accounts.pool;
    require!(!cfg.paused, BideError::Paused);
    require!(!pool.paused, BideError::PoolPaused);
    require!(r.status == RoundStatus::Auction, BideError::WrongStatus);
    let pool_open = r.auction_start + r.auction_secs as i64 + r.pool_delay_secs as i64;
    require!(now >= pool_open, BideError::PoolWindowNotReached);
    // deadline: same moment cancel_round becomes permissionless, and never once sampling has started
    require!(now <= pool_open + CANCEL_ANYONE_DELAY_SECS, BideError::AuctionOver);
    let epoch = &ctx.accounts.epoch;
    require!(epoch.status == EpochStatus::Open, BideError::EpochNotOpen);
    require!(now < window_start(epoch), BideError::AuctionOver);
    if r.kind == RoundKind::Put {
        require_keys_eq!(ctx.accounts.asset.mint, WSOL_MINT, BideError::InvalidMint);
    }
    // spot guard + spot for NAV (asset is SOL for puts; for calls the pool only needs USDC, but NAV uses SOL spot)
    let spot = oracle::read_spot(&ctx.accounts.asset, &ctx.accounts.spot_feed, now)?;
    require!(
        math::within_bps(spot, r.spot_at_open, r.spot_at_open, ctx.accounts.asset.max_spot_move_bps),
        BideError::SpotMovedTooMuch
    );
    let premium = r.premium_floor;
    let notional = r.notional;
    require!(
        premium <= math::mul_div_floor(notional, pool.max_premium_bps_of_notional as u64, BPS)?,
        BideError::PoolCapExceeded
    );
    // free funds
    let (usdc_need, wsol_need) = match r.kind {
        RoundKind::Put => (premium, r.size),
        RoundKind::Call => (premium.checked_add(notional).ok_or(BideError::MathOverflow)?, 0),
    };
    require!(
        usdc_need <= ctx.accounts.pool_usdc.amount && wsol_need <= ctx.accounts.pool_wsol.amount,
        BideError::InsufficientFreeFunds
    );
    // caps
    let open_after = pool.open_notional.checked_add(notional).ok_or(BideError::MathOverflow)?;
    require!(open_after <= pool.max_open_notional, BideError::PoolCapExceeded);
    let nav = super::pool::pool_nav(
        pool,
        ctx.accounts.pool_usdc.amount,
        ctx.accounts.pool_wsol.amount,
        pool.lend_shares,
        &ctx.accounts.lending_usdc,
        spot,
    )?
    .total()?;
    require!(
        (open_after as u128) * (BPS as u128) <= (nav as u128) * (pool.max_utilization_bps as u128),
        BideError::PoolCapExceeded
    );
    let (win_start, spent) = if now >= pool.spend_window_start + pool.spend_window_secs as i64 {
        (now, 0u64)
    } else {
        (pool.spend_window_start, pool.spend_window_spent)
    };
    let spent_after = spent.checked_add(premium).ok_or(BideError::MathOverflow)?;
    require!(spent_after <= pool.spend_window_cap, BideError::PoolCapExceeded);

    let tp = ctx.accounts.token_program.to_account_info();
    let auth = ctx.accounts.pool_auth.to_account_info();
    let pool_key = pool.key();
    let seeds: &[&[u8]] = &[SEED_LEND_AUTH, pool_key.as_ref(), &[pool.lend_auth_bump]];
    let fee = pay_premium(
        &tp,
        cfg,
        &ctx.accounts.plan,
        &ctx.accounts.pool_usdc.to_account_info(),
        &auth,
        Some(seeds),
        &ctx.accounts.owner_usdc,
        &ctx.accounts.fee_usdc,
        premium,
    )?;
    let escrow = ctx.accounts.escrow.to_account_info();
    match r.kind {
        RoundKind::Put => util::transfer(&tp, &ctx.accounts.pool_wsol.to_account_info(), &escrow, &auth, Some(seeds), r.size)?,
        RoundKind::Call => util::transfer(&tp, &ctx.accounts.pool_usdc.to_account_info(), &escrow, &auth, Some(seeds), notional)?,
    }
    let kind = r.kind;
    let size = r.size;
    let pool = &mut ctx.accounts.pool;
    pool.open_notional = open_after;
    pool.spend_window_start = win_start;
    pool.spend_window_spent = spent_after;
    match kind {
        RoundKind::Put => pool.reserved_wsol = pool.reserved_wsol.checked_add(size).ok_or(BideError::MathOverflow)?,
        RoundKind::Call => pool.reserved_usdc = pool.reserved_usdc.checked_add(notional).ok_or(BideError::MathOverflow)?,
    }
    let r = &mut ctx.accounts.round;
    r.maker = pool_key;
    r.maker_is_pool = true;
    r.premium_paid = premium;
    r.fee_paid = fee;
    r.status = RoundStatus::Live;
    emit!(RoundTaken { round: r.key(), plan: r.plan, maker: pool_key, premium, fee, is_pool: true });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelRound<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = round.plan)]
    pub plan: Box<Account<'info, Plan>>,
    #[account(mut, close = rent_payer)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [SEED_ESCROW, round.key().as_ref()], bump = round.escrow_bump)]
    pub escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: receives rent back
    #[account(mut, address = round.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn round_seeds_close<'info>(
    tp: &AccountInfo<'info>,
    round: &Account<'info, Round>,
    escrow: &AccountInfo<'info>,
    rent_payer: &AccountInfo<'info>,
) -> Result<()> {
    let idx = round.round_index.to_le_bytes();
    let seeds: &[&[u8]] = &[SEED_ROUND, round.plan.as_ref(), &idx, &[round.bump]];
    util::close_token_account(tp, escrow, rent_payer, &round.to_account_info(), seeds)
}

pub fn cancel_round<'info>(ctx: Context<'info, CancelRound<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let r = &ctx.accounts.round;
    require!(r.status == RoundStatus::Auction, BideError::WrongStatus);
    let pool_open = r.auction_start + r.auction_secs as i64 + r.pool_delay_secs as i64;
    let s = ctx.accounts.signer.key();
    let ok = s == ctx.accounts.plan.owner
        || (s == ctx.accounts.config.agent && now >= pool_open)
        || now >= pool_open + CANCEL_ANYONE_DELAY_SECS;
    require!(ok, BideError::Unauthorized);
    // Anyone can transfer tokens into the escrow; a non-empty escrow must never block cancellation.
    // Sweep any surplus to the plan owner's token account of the escrow mint, passed as remaining_accounts[0].
    let surplus = ctx.accounts.escrow.amount;
    if surplus > 0 {
        let dest = ctx.remaining_accounts.first().ok_or(BideError::InvalidAccount)?;
        require!(dest.is_writable, BideError::InvalidAccount);
        util::check_token_account(dest, &ctx.accounts.escrow.mint, Some(&ctx.accounts.plan.owner))?;
        let idx = r.round_index.to_le_bytes();
        let rseeds: &[&[u8]] = &[SEED_ROUND, r.plan.as_ref(), &idx, &[r.bump]];
        util::transfer(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.escrow.to_account_info(),
            dest,
            &ctx.accounts.round.to_account_info(),
            Some(rseeds),
            surplus,
        )?;
    }
    round_seeds_close(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.round,
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.rent_payer.to_account_info(),
    )?;
    let plan = &mut ctx.accounts.plan;
    if plan.active_round == Some(r.key()) {
        plan.active_round = None;
    }
    ctx.accounts.round.status = RoundStatus::Cancelled;
    emit!(RoundCancelled { round: ctx.accounts.round.key(), plan: plan.key() });
    Ok(())
}
