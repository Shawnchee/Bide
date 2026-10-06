use crate::errors::BideError;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, spl_token, CloseAccount, TokenAccount, Transfer};

/// Canonical vault address: the classic-Token ATA of `mint` owned by `owner` (a program PDA).
/// Every plan/pool vault is this ATA (shared client + create_plan / init_pool flows).
pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address(owner, mint)
}

/// Reject any token account that isn't the canonical ATA(mint, owner). A third party can create other token
/// accounts with a PDA as authority; without this check they could substitute them for the real vaults.
pub fn require_ata(acc: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Result<()> {
    require_keys_eq!(*acc, ata(owner, mint), BideError::InvalidAccount);
    Ok(())
}

/// Unpack an SPL token account and check mint (+ optional owner).
pub fn check_token_account(acc: &AccountInfo, mint: &Pubkey, owner: Option<&Pubkey>) -> Result<TokenAccount> {
    require_keys_eq!(*acc.owner, spl_token::ID, BideError::InvalidAccount);
    let data = acc.try_borrow_data()?;
    let ta = TokenAccount::try_deserialize(&mut &data[..]).map_err(|_| error!(BideError::InvalidAccount))?;
    require_keys_eq!(ta.mint, *mint, BideError::InvalidMint);
    if let Some(o) = owner {
        require_keys_eq!(ta.owner, *o, BideError::InvalidAccount);
    }
    Ok(ta)
}

pub fn transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: Option<&[&[u8]]>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accs = Transfer { from: from.clone(), to: to.clone(), authority: authority.clone() };
    match seeds {
        Some(s) => {
            let signer: &[&[&[u8]]] = &[s];
            token::transfer(CpiContext::new_with_signer(token_program.key(), accs, signer), amount)
        }
        None => token::transfer(CpiContext::new(token_program.key(), accs), amount),
    }
}

pub fn close_token_account<'info>(
    token_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    let signer: &[&[&[u8]]] = &[seeds];
    token::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount { account: account.clone(), destination: destination.clone(), authority: authority.clone() },
        signer,
    ))
}
