# Adversarial review

Reviewed: 6 October 2026. Source revision: `ac56aac3dacfa5d195bffbf74f948af636d70841`.

Scope: local review of the Solana program, collateral lifecycle, pool accounting, shared instruction builders, worker HTTP controls, and existing tests. Findings below come from source inspection; no exploit demonstrations were run, no live devnet transactions were submitted, and no application fixes were applied. This is a focused review, not a comprehensive audit. Priorities describe impact on the deployed logic even though the project uses devnet tokens.

## Findings

### 1. Critical — substitute pool vaults can inflate newly minted LP shares

**Location:** `programs/bide/src/instructions/pool.rs:127–130,150–167,205–210`.

Pool deposits validate the vaults' token mint and authority, but never their addresses. A token account owned by the pool PDA is not necessarily the pool's canonical vault. A third party can initialize another SPL token account with that PDA as its token authority; this does not require the PDA to sign.

The deposit calculation reads balances from the caller-supplied accounts. Substituting an empty account hides existing pool assets from NAV while retaining the real share supply. The resulting deposit mints too many shares, which the holder can subsequently redeem against the canonical vaults. The virtual-share offset does not fix this: it limits donation-based inflation, but does not authenticate the balances used for pricing.

**Impact:** existing LPs can lose devnet pool assets to an unprivileged depositor. The shared client always supplies ATAs, but callers can construct their own instructions.

**Fix:** bind every pool vault to a canonical ATA or an address stored at initialization. Apply this consistently to deposit, withdrawal, lending, and pool round-taking. For example:

```rust
#[account(
    mut,
    associated_token::mint = USDC_MINT,
    associated_token::authority = pool_auth
)]
pub pool_usdc: Box<Account<'info, TokenAccount>>,
```

Use the equivalent WSOL and fToken constraints, or explicit address checks where required by the account layout.

**Regression to add:** a deposit supplied with a noncanonical but correctly owned vault must fail before minting shares. Repeat for each vault independently and verify honest LP balances remain unchanged.

### 2. Critical — permissionless expiry can close a plan without returning its real collateral

**Location:** `programs/bide/src/instructions/plan.rs:276–305,313–333,344–349`.

`expire_plan` permits any caller after the deadline. Its drain routine validates supplied vaults by mint and authority, but does not require the actual vault addresses. An empty replacement fToken account passes those checks and skips redemption because `vf.amount == 0`. Empty replacement collateral and Wheel asset accounts likewise appear to contain nothing to return.

The routine then marks the plan `Closed` and clears its accounting. The real vaults retain their balances, while subsequent drain attempts are rejected by the closed-status guard. The existing Wheel regression checks that an asset account is present, not that it is the correct account.

**Impact:** an unrelated caller can strand an expired, otherwise withdrawable plan's collateral through the normal program interface. This contradicts the claim that permissionless expiry always preserves a recovery path.

**Fix:** enforce canonical addresses for collateral, fToken, and Wheel asset vaults before draining or changing status. Check the fToken address even when its supplied balance is zero. If supporting non-ATA vaults, record their addresses at creation and enforce those stored values. A recovery instruction for already-closed plans would require a separate design and review.

```rust
require_keys_eq!(vf.key(), expected_f_token_vault, BideError::InvalidAccount);
require_keys_eq!(vc.key(), expected_collateral_vault, BideError::InvalidAccount);
// Check the Wheel asset vault against its expected address as well.
```

**Regression to add:** permissionless expiry using each substitute account must fail with the plan still open and the original balances untouched; legitimate expiry must return the original collateral.

### 3. High — settlement can send PDA-owned assets outside the vaults that accounting tracks

**Location:** `programs/bide/src/instructions/settle.rs:153–156,233–240,357–374`; `programs/bide/src/instructions/plan.rs:553–557`.

Pool settlement destinations are checked only for mint and pool authority. Wheel put delivery similarly checks the plan authority without binding the destination to the canonical asset vault. These settlement operations are permissionless.

A substituted destination therefore receives the tokens while the state transition proceeds. For the pool, the corresponding reservation or receivable is released even though the canonical vault has not received the tokens. For a Wheel plan, `size_filled` advances while the standard client's asset vault stays empty; `flip_plan` then fails its positive-balance check.

**Impact:** incorrect pool NAV and broken normal Wheel progression. These tokens remain PDA-owned, so this finding alone does not establish direct theft or permanent loss; recovery would require accounting-aware handling of the alternate account. Pool shares can nevertheless be priced against incomplete balances in the meantime.

**Fix:** require the canonical destination whenever the beneficiary is a program PDA. Keep user/maker destinations flexible only where their wallet controls recovery.

```rust
if r.maker_is_pool {
    require_keys_eq!(dest.key(), expected_pool_vault, BideError::InvalidAccount);
}
// For an exercised Wheel put, also require user_dest == expected_plan_asset_vault.
```

**Regression to add:** reject alternate pool destinations in resolve, unwind, and collateral withdrawal; reject alternate Wheel delivery destinations. Confirm a rejected call leaves balances, reservations, and plan state unchanged.

## Validation and limits

- `anchor build` completed successfully. It emitted existing compiler warnings and an SBF undefined-syscall warning; build success alone is not runtime validation.
- All 28 existing program tests passed against the local program build in LiteSVM. They cover the existing happy paths and earlier regressions, but do not establish rejection of the substitute-account cases above.
- The worker suite finished with 195 of 196 tests passing. One test could not bind a local HTTP server because the sandbox returned `EPERM`; this is an environment limitation, not evidence of a worker defect.
- The initial test launcher also hit a sandbox IPC restriction. Running through `node --import tsx --test` allowed the suites to execute without that launcher.
- No new adversarial tests or exploit transactions were executed, in accordance with the request to deliver the review only. Findings remain source-supported, not experimentally reproduced.

## Recommended order

Fix canonical vault and destination validation as one consistent change across the program. Then add the targeted negative tests above and rerun the existing suites. Avoid treating the SDK's choice of ATAs as an on-chain security guarantee.
