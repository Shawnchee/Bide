use crate::{constants::*, errors::BideError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [SEED_CONFIG], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

pub fn init_config(ctx: Context<InitConfig>, agent: Pubkey, fee_bps: u16, fee_recipient: Pubkey) -> Result<()> {
    require!(fee_bps <= FEE_BPS_CAP, BideError::FeeTooHigh);
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.agent = agent;
    c.paused = false;
    c.fee_bps = fee_bps;
    c.fee_recipient = fee_recipient;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ BideError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn rotate_agent(ctx: Context<AdminOnly>, new_agent: Pubkey) -> Result<()> {
    ctx.accounts.config.agent = new_agent;
    Ok(())
}

pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}

pub fn set_fee(ctx: Context<AdminOnly>, fee_bps: u16, fee_recipient: Pubkey) -> Result<()> {
    require!(fee_bps <= FEE_BPS_CAP, BideError::FeeTooHigh);
    ctx.accounts.config.fee_bps = fee_bps;
    ctx.accounts.config.fee_recipient = fee_recipient;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AssetParams {
    pub decimals: u8,
    pub pyth_feed_id: [u8; 32],
    pub spot_feed: Pubkey,
    pub strike_tick: u64,
    pub max_conf_bps: u16,
    pub max_spot_move_bps: u16,
    pub max_spot_age_secs: u32,
    pub enabled: bool,
}

#[derive(Accounts)]
pub struct AddAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ BideError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = admin, space = 8 + Asset::INIT_SPACE, seeds = [SEED_ASSET, mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,
    pub system_program: Program<'info, System>,
}

fn apply_params(a: &mut Asset, p: &AssetParams) -> Result<()> {
    require!(p.strike_tick > 0, BideError::ZeroAmount);
    a.pyth_feed_id = p.pyth_feed_id;
    a.spot_feed = p.spot_feed;
    a.strike_tick = p.strike_tick;
    a.max_conf_bps = p.max_conf_bps;
    a.max_spot_move_bps = p.max_spot_move_bps;
    a.max_spot_age_secs = p.max_spot_age_secs;
    a.enabled = p.enabled;
    Ok(())
}

pub fn add_asset(ctx: Context<AddAsset>, params: AssetParams) -> Result<()> {
    require!(ctx.accounts.mint.decimals == params.decimals, BideError::InvalidMint);
    let mint = ctx.accounts.mint.key();
    require!(mint != USDC_MINT, BideError::InvalidMint);
    let a = &mut ctx.accounts.asset;
    a.mint = mint;
    a.decimals = params.decimals;
    a.lend_f_token_mint = crate::lend::f_token_for_mint(&mint).unwrap_or_default();
    a.bump = ctx.bumps.asset;
    apply_params(a, &params)
}

#[derive(Accounts)]
pub struct UpdateAsset<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ BideError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [SEED_ASSET, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Account<'info, Asset>,
}

/// Addition to BUILD §3.3: admin can tune asset params (spot age, conf, enable) without redeploying.
pub fn update_asset(ctx: Context<UpdateAsset>, params: AssetParams) -> Result<()> {
    let a = &mut ctx.accounts.asset;
    require!(a.decimals == params.decimals, BideError::InvalidMint);
    apply_params(a, &params)
}
