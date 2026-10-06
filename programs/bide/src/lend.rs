//! Jupiter Lend (Earn) CPI. ALL Lend interaction lives here so a plan-B swap stays local.
//!
//! A market is passed as 13 remaining accounts in this canonical order (see packages/shared lendMarketMetas):
//!   0 lending_admin, 1 lending (w), 2 mint, 3 f_token_mint (w), 4 supply_token_reserves_liquidity (w),
//!   5 lending_supply_position_on_liquidity (w), 6 rate_model, 7 vault (w), 8 claim_account (w),
//!   9 liquidity (w), 10 liquidity_program, 11 rewards_rate_model, 12 lending program
//! The signer is a data-less, system-owned PDA ["lend_auth", plan|pool] that owns both the underlying
//! token account and the fToken account (both pre-created).
use crate::{constants::*, errors::BideError};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

pub const LEND_MARKET_ACCOUNTS: usize = 13;

const IX_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const IX_REDEEM: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];
const IX_UPDATE_RATE: [u8; 8] = [24, 225, 53, 189, 72, 212, 225, 178];

pub fn f_token_for_mint(mint: &Pubkey) -> Option<Pubkey> {
    if *mint == USDC_MINT {
        Some(LEND_USDC_FTOKEN)
    } else if *mint == WSOL_MINT {
        Some(LEND_WSOL_FTOKEN)
    } else {
        None
    }
}

pub fn lending_for_mint(mint: &Pubkey) -> Option<Pubkey> {
    if *mint == USDC_MINT {
        Some(LEND_USDC_LENDING)
    } else if *mint == WSOL_MINT {
        Some(LEND_WSOL_LENDING)
    } else {
        None
    }
}

#[derive(Clone, Copy)]
pub struct LendMarket<'a, 'info> {
    pub a: &'a [AccountInfo<'info>],
}

impl<'a, 'info> LendMarket<'a, 'info> {
    /// Take a validated market from `rem[offset..offset+13]` for `mint`.
    pub fn from_remaining(rem: &'a [AccountInfo<'info>], offset: usize, mint: &Pubkey) -> Result<Self> {
        require!(rem.len() >= offset + LEND_MARKET_ACCOUNTS, BideError::InvalidLendAccounts);
        let a = &rem[offset..offset + LEND_MARKET_ACCOUNTS];
        require_keys_eq!(a[12].key(), LEND_PROGRAM, BideError::InvalidLendAccounts);
        require_keys_eq!(a[10].key(), LIQUIDITY_PROGRAM, BideError::InvalidLendAccounts);
        require_keys_eq!(a[2].key(), *mint, BideError::InvalidLendAccounts);
        let ft = f_token_for_mint(mint).ok_or(BideError::InvalidMint)?;
        require_keys_eq!(a[3].key(), ft, BideError::InvalidLendAccounts);
        let lending = lending_for_mint(mint).ok_or(BideError::InvalidMint)?;
        require_keys_eq!(a[1].key(), lending, BideError::InvalidLendAccounts);
        require_keys_eq!(*a[1].owner, LEND_PROGRAM, BideError::InvalidLendAccounts);
        Ok(Self { a })
    }

    fn lending_admin(&self) -> &AccountInfo<'info> { &self.a[0] }
    pub fn lending(&self) -> &AccountInfo<'info> { &self.a[1] }
    pub fn mint(&self) -> &AccountInfo<'info> { &self.a[2] }
    pub fn f_token_mint(&self) -> &AccountInfo<'info> { &self.a[3] }
    fn reserve(&self) -> &AccountInfo<'info> { &self.a[4] }
    fn supply_position(&self) -> &AccountInfo<'info> { &self.a[5] }
    fn rate_model(&self) -> &AccountInfo<'info> { &self.a[6] }
    fn vault(&self) -> &AccountInfo<'info> { &self.a[7] }
    fn claim_account(&self) -> &AccountInfo<'info> { &self.a[8] }
    fn liquidity(&self) -> &AccountInfo<'info> { &self.a[9] }
    fn liquidity_program(&self) -> &AccountInfo<'info> { &self.a[10] }
    fn rewards_rate_model(&self) -> &AccountInfo<'info> { &self.a[11] }
    fn program(&self) -> &AccountInfo<'info> { &self.a[12] }
}

/// Programs Lend's deposit/withdraw need at the tail.
pub struct LendPrograms<'a, 'info> {
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

pub fn token_amount(acc: &AccountInfo) -> Result<u64> {
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 72, BideError::InvalidAccount);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

fn meta(acc: &AccountInfo, w: bool) -> AccountMeta {
    if w { AccountMeta::new(acc.key(), false) } else { AccountMeta::new_readonly(acc.key(), false) }
}

pub fn update_rate<'info>(m: &LendMarket<'_, 'info>) -> Result<()> {
    let ix = Instruction {
        program_id: LEND_PROGRAM,
        accounts: vec![
            meta(m.lending(), true),
            meta(m.mint(), false),
            meta(m.f_token_mint(), false),
            meta(m.reserve(), false),
            meta(m.rewards_rate_model(), false),
        ],
        data: IX_UPDATE_RATE.to_vec(),
    };
    invoke_signed(
        &ix,
        &[
            m.lending().clone(),
            m.mint().clone(),
            m.f_token_mint().clone(),
            m.reserve().clone(),
            m.rewards_rate_model().clone(),
            m.program().clone(),
        ],
        &[],
    )?;
    Ok(())
}

/// Deposit `amount` underlying from `src` (owned by signer) → fTokens into `f_dst` (owned by signer).
/// Returns fTokens minted (balance delta).
pub fn deposit<'info>(
    m: &LendMarket<'_, 'info>,
    p: &LendPrograms<'_, 'info>,
    signer: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    src: &AccountInfo<'info>,
    f_dst: &AccountInfo<'info>,
    amount: u64,
) -> Result<u64> {
    require!(amount > 0, BideError::ZeroAmount);
    update_rate(m)?;
    let before = token_amount(f_dst)?;
    let mut data = IX_DEPOSIT.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: LEND_PROGRAM,
        accounts: vec![
            AccountMeta::new(signer.key(), true),
            meta(src, true),
            meta(f_dst, true),
            meta(m.mint(), false),
            meta(m.lending_admin(), false),
            meta(m.lending(), true),
            meta(m.f_token_mint(), true),
            meta(m.reserve(), true),
            meta(m.supply_position(), true),
            meta(m.rate_model(), false),
            meta(m.vault(), true),
            meta(m.liquidity(), true),
            meta(m.liquidity_program(), true),
            meta(m.rewards_rate_model(), false),
            meta(p.token_program, false),
            meta(p.associated_token_program, false),
            meta(p.system_program, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            signer.clone(), src.clone(), f_dst.clone(), m.mint().clone(), m.lending_admin().clone(),
            m.lending().clone(), m.f_token_mint().clone(), m.reserve().clone(), m.supply_position().clone(),
            m.rate_model().clone(), m.vault().clone(), m.liquidity().clone(), m.liquidity_program().clone(),
            m.rewards_rate_model().clone(), p.token_program.clone(), p.associated_token_program.clone(),
            p.system_program.clone(), m.program().clone(),
        ],
        &[signer_seeds],
    )?;
    let after = token_amount(f_dst)?;
    let minted = after.checked_sub(before).ok_or(BideError::MathOverflow)?;
    require!(minted > 0, BideError::ZeroAmount);
    Ok(minted)
}

enum Out {
    Withdraw,
    Redeem,
}

fn withdraw_inner<'info>(
    m: &LendMarket<'_, 'info>,
    p: &LendPrograms<'_, 'info>,
    signer: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    f_src: &AccountInfo<'info>,
    dst: &AccountInfo<'info>,
    which: Out,
    arg: u64,
) -> Result<(u64, u64)> {
    require!(arg > 0, BideError::ZeroAmount);
    update_rate(m)?;
    let f_before = token_amount(f_src)?;
    let u_before = token_amount(dst)?;
    let mut data = match which {
        Out::Withdraw => IX_WITHDRAW.to_vec(),
        Out::Redeem => IX_REDEEM.to_vec(),
    };
    data.extend_from_slice(&arg.to_le_bytes());
    let ix = Instruction {
        program_id: LEND_PROGRAM,
        accounts: vec![
            AccountMeta::new(signer.key(), true),
            meta(f_src, true),
            meta(dst, true),
            meta(m.lending_admin(), false),
            meta(m.lending(), true),
            meta(m.mint(), false),
            meta(m.f_token_mint(), true),
            meta(m.reserve(), true),
            meta(m.supply_position(), true),
            meta(m.rate_model(), false),
            meta(m.vault(), true),
            meta(m.claim_account(), true),
            meta(m.liquidity(), true),
            meta(m.liquidity_program(), true),
            meta(m.rewards_rate_model(), false),
            meta(p.token_program, false),
            meta(p.associated_token_program, false),
            meta(p.system_program, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            signer.clone(), f_src.clone(), dst.clone(), m.lending_admin().clone(), m.lending().clone(),
            m.mint().clone(), m.f_token_mint().clone(), m.reserve().clone(), m.supply_position().clone(),
            m.rate_model().clone(), m.vault().clone(), m.claim_account().clone(), m.liquidity().clone(),
            m.liquidity_program().clone(), m.rewards_rate_model().clone(), p.token_program.clone(),
            p.associated_token_program.clone(), p.system_program.clone(), m.program().clone(),
        ],
        &[signer_seeds],
    )?;
    let burned = f_before.checked_sub(token_amount(f_src)?).ok_or(BideError::MathOverflow)?;
    let received = token_amount(dst)?.checked_sub(u_before).ok_or(BideError::MathOverflow)?;
    Ok((received, burned))
}

/// Withdraw exactly `amount` underlying (withdraw-by-amount). Returns (received, shares_burned).
pub fn withdraw<'info>(
    m: &LendMarket<'_, 'info>,
    p: &LendPrograms<'_, 'info>,
    signer: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    f_src: &AccountInfo<'info>,
    dst: &AccountInfo<'info>,
    amount: u64,
) -> Result<(u64, u64)> {
    withdraw_inner(m, p, signer, signer_seeds, f_src, dst, Out::Withdraw, amount)
}

/// Redeem `shares` fTokens. Returns (received, shares_burned).
pub fn redeem<'info>(
    m: &LendMarket<'_, 'info>,
    p: &LendPrograms<'_, 'info>,
    signer: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    f_src: &AccountInfo<'info>,
    dst: &AccountInfo<'info>,
    shares: u64,
) -> Result<(u64, u64)> {
    withdraw_inner(m, p, signer, signer_seeds, f_src, dst, Out::Redeem, shares)
}

/// Lending.token_exchange_price (1e12) — refreshed by update_rate; used for pool NAV.
pub fn token_exchange_price(lending: &AccountInfo) -> Result<u64> {
    require_keys_eq!(*lending.owner, LEND_PROGRAM, BideError::InvalidLendAccounts);
    let d = lending.try_borrow_data()?;
    let o = LENDING_TOKEN_EXCHANGE_PRICE_OFFSET;
    require!(d.len() >= o + 8, BideError::InvalidLendAccounts);
    Ok(u64::from_le_bytes(d[o..o + 8].try_into().unwrap()))
}

/// shares → underlying (floor)
pub fn shares_to_assets(shares: u64, price: u64) -> Result<u64> {
    let v = (shares as u128)
        .checked_mul(price as u128)
        .ok_or(BideError::MathOverflow)?
        / LEND_EXCHANGE_PRICE_PRECISION;
    u64::try_from(v).map_err(|_| error!(BideError::MathOverflow))
}
