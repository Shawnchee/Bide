#![allow(unexpected_cfgs)]
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod lend;
pub mod math;
pub mod oracle;
pub mod state;
pub mod util;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe");

#[program]
pub mod bide {
    use super::*;

    // ---- admin ----
    pub fn init_config(ctx: Context<InitConfig>, agent: Pubkey, fee_bps: u16, fee_recipient: Pubkey) -> Result<()> {
        instructions::admin::init_config(ctx, agent, fee_bps, fee_recipient)
    }
    pub fn add_asset(ctx: Context<AddAsset>, params: AssetParams) -> Result<()> {
        instructions::admin::add_asset(ctx, params)
    }
    pub fn update_asset(ctx: Context<UpdateAsset>, params: AssetParams) -> Result<()> {
        instructions::admin::update_asset(ctx, params)
    }
    pub fn rotate_agent(ctx: Context<AdminOnly>, new_agent: Pubkey) -> Result<()> {
        instructions::admin::rotate_agent(ctx, new_agent)
    }
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::set_paused(ctx, paused)
    }
    pub fn set_fee(ctx: Context<AdminOnly>, fee_bps: u16, fee_recipient: Pubkey) -> Result<()> {
        instructions::admin::set_fee(ctx, fee_bps, fee_recipient)
    }

    // ---- plans ----
    pub fn create_plan<'info>(ctx: Context<'info, CreatePlan<'info>>, args: CreatePlanArgs) -> Result<()> {
        instructions::plan::create_plan(ctx, args)
    }
    pub fn pause_plan(ctx: Context<PausePlan>, paused: bool) -> Result<()> {
        instructions::plan::pause_plan(ctx, paused)
    }
    pub fn close_plan<'info>(ctx: Context<'info, ClosePlan<'info>>) -> Result<()> {
        instructions::plan::close_plan(ctx)
    }
    pub fn expire_plan<'info>(ctx: Context<'info, ClosePlan<'info>>) -> Result<()> {
        instructions::plan::expire_plan(ctx)
    }
    pub fn update_plan<'info>(ctx: Context<'info, UpdatePlan<'info>>, args: UpdatePlanArgs) -> Result<()> {
        instructions::plan::update_plan(ctx, args)
    }
    pub fn flip_plan<'info>(ctx: Context<'info, FlipPlan<'info>>) -> Result<()> {
        instructions::plan::flip_plan(ctx)
    }

    // ---- rounds ----
    pub fn open_round(ctx: Context<OpenRound>, args: OpenRoundArgs) -> Result<()> {
        instructions::round::open_round(ctx, args)
    }
    pub fn take_round(ctx: Context<TakeRound>) -> Result<()> {
        instructions::round::take_round(ctx)
    }
    pub fn pool_take_round(ctx: Context<PoolTakeRound>) -> Result<()> {
        instructions::round::pool_take_round(ctx)
    }
    pub fn cancel_round<'info>(ctx: Context<'info, CancelRound<'info>>) -> Result<()> {
        instructions::round::cancel_round(ctx)
    }

    // ---- settlement ----
    pub fn open_epoch(ctx: Context<OpenEpoch>, kind: EpochKind, expiry: i64) -> Result<()> {
        instructions::settle::open_epoch(ctx, kind, expiry)
    }
    pub fn post_sample(ctx: Context<PostSample>, bucket: u8) -> Result<()> {
        instructions::settle::post_sample(ctx, bucket)
    }
    pub fn resolve_epoch(ctx: Context<ResolveEpoch>) -> Result<()> {
        instructions::settle::resolve_epoch(ctx)
    }
    pub fn resolve_round(ctx: Context<ResolveRound>) -> Result<()> {
        instructions::settle::resolve_round(ctx)
    }
    pub fn withdraw_collateral<'info>(ctx: Context<'info, WithdrawCollateral<'info>>) -> Result<()> {
        instructions::settle::withdraw_collateral(ctx)
    }
    pub fn unwind_round(ctx: Context<UnwindRound>) -> Result<()> {
        instructions::settle::unwind_round(ctx)
    }

    // ---- pool ----
    pub fn init_pool(ctx: Context<InitPool>, params: PoolParams) -> Result<()> {
        instructions::pool::init_pool(ctx, params)
    }
    pub fn pool_deposit(ctx: Context<PoolDeposit>, amount: u64) -> Result<()> {
        instructions::pool::pool_deposit(ctx, amount)
    }
    pub fn pool_withdraw(ctx: Context<PoolWithdraw>, shares: u64) -> Result<()> {
        instructions::pool::pool_withdraw(ctx, shares)
    }
    pub fn pool_lend_idle<'info>(ctx: Context<'info, PoolLend<'info>>, amount: u64) -> Result<()> {
        instructions::pool::pool_lend_idle(ctx, amount)
    }
    pub fn set_pool_params(ctx: Context<SetPoolPaused>, paused: bool, params: PoolParams) -> Result<()> {
        instructions::pool::set_pool_params(ctx, paused, params)
    }
    pub fn pool_unlend<'info>(ctx: Context<'info, PoolLend<'info>>, amount: u64) -> Result<()> {
        instructions::pool::pool_unlend(ctx, amount)
    }
}
