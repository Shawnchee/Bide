# Adversarial codebase review (devnet)

**Date:** 2026-10-07  
**Scope:** Current workspace source, including the Solana program, worker, Next.js app, Supabase migrations, and the existing tests/review notes. This is a source review, not a formal audit.

## Environment checked

The repository targets **Solana devnet**: `Anchor.toml` sets the provider cluster to `devnet`; the worker and app default to `https://api.devnet.solana.com`; the app declares `CLUSTER = "devnet"`; and the configured RPC environment values classify as devnet. The README also identifies the deployed program and transaction evidence as devnet.

I could not confirm the live deployment during this pass. `solana program show ... --url devnet` failed because the devnet RPC request could not connect. Findings below describe behavior in the current checked-out source and do not assert that the same code is currently deployed.

## Findings

### P1 — Pool LP shares can be minted after an option outcome is known but before its payoff is booked

**Affected code:** `programs/bide/src/instructions/pool.rs` (`pool_nav`, `pool_deposit`); `programs/bide/src/instructions/round.rs` (`pool_take_round`); `programs/bide/src/instructions/settle.rs` (`resolve_round` and `release_pool`).

`pool_deposit` prices shares from the pool's vault balances and `reserved_*` fields. While a pool round is still live, those fields mark the escrowed leg at spot. Once the epoch is resolved, the option outcome and payoff are public on-chain, but the pool's reserved accounting is not changed until anyone calls `resolve_round`. An attacker can deposit in that interval, receive shares at the pre-settlement NAV, then permissionlessly resolve the round and withdraw their shares after the pool's NAV includes the settlement receivable.

For an exercised Put, the pool's escrowed asset is delivered to the user and the user owes the pool the strike notional. Before `resolve_round`, the pool NAV counts the reserved asset at spot. After resolution, `release_pool` replaces that reservation with a USDC receivable at strike notional. When strike exceeds the already-known settlement price, this books a gain after the attacker bought shares. The attacker captures a pro-rata part of that gain without bearing the round's prior risk; the same stale-mark window should be checked for Call outcomes and losses before deploying the pool to real users.

**Attack path:** wait until a pool-backed epoch is `Resolved`; deposit as a new LP before `resolve_round`; call `resolve_round` and `withdraw_collateral` permissionlessly; withdraw the newly minted shares. No pool/admin key is needed. `tests/src/codex-v2-repro.ts` now contains a review reproduction for the exercised-Put case, but that new reproduction was not run in this pass.

**Suggested fix:** value pool shares against accrued and marked-to-market open round liabilities/payoffs, and prevent deposits/redemptions while an epoch is resolved but its pool rounds are not fully accounted for. A robust design should make the accounting update atomic with outcome resolution or derive NAV from all open and resolved pool positions, rather than relying on a keeper to call settlement first.

### P2 — The app wraps too little SOL for a Sell plan, so the default create flow fails

**Affected code:** `app/lib/plan-math.ts` (`buildDraft`); `app/lib/tx.ts` (`buildCreatePlanTx`); `programs/bide/src/instructions/plan.rs` (`create_plan`).

For a Sell plan, `buildDraft` sets `lockAmount` to exactly `size`. `buildCreatePlanTx` wraps exactly `draft.lockAmount` into WSOL. On-chain `create_plan` then transfers `size_total + LEND_DUST_BUFFER` (10 lamports) from the owner's WSOL account. A user following the app flow with exactly the displayed amount therefore has an insufficient balance and the transaction fails. The shared client comment already says callers must wrap `size + 10`, and program tests use that buffer, while the app builder omits it.

**Suggested fix:** wrap `draft.lockAmount + LEND_DUST_BUFFER` for WSOL Sell plans (or change the UI's displayed required amount and centralize the buffer constant). Keep the tBTC path free of a WSOL wrap.

## Areas reviewed without an additional confirmed exploit

- Program authority and account constraints across plan creation/updates/close, round opening/taking/settlement, epoch sampling, and pool operations.
- Pyth receiver ownership, feed identity, verification level, sample bucket timing, and settlement rules.
- Checked integer math, strike/size limits, replay/state transitions, token destinations, and canonical program vault addresses.
- Worker shared-secret gates, request validation, queue/rate limits, RPC interactions, and public route behavior.
- App server routes, wallet transaction construction, environment exposure, and Supabase table grants/RLS policies in the checked-in migrations.

Previously documented items in `z_review.md` and `z_v2_review.md` were cross-checked where they touch these paths. They are not repeated here as newly discovered issues. In particular, the repo already records deployment authority/timelock risks and accepted settlement/Lend accounting limitations for a future mainnet launch; this report's confirmed findings apply to current devnet source behavior.

## Checks and limits

- Program LiteSVM suite: **34 passed, 0 failed** (the checked-in review reproduction file is not named as a `*.test.ts` file and was not included).
- App TypeScript check: passed.
- Worker tests: **205 passed, 1 failed**. The failure is the loopback-server fallback test in `worker/test/robustness.test.ts`; the sandbox denied binding to `127.0.0.1` (`EPERM`), so this run does not establish a product failure there.
- Live devnet program query: unverified because the RPC request could not connect.

The pool finding follows directly from the source's share-mint and settlement accounting sequence; its end-to-end reproduction remains unverified in this pass. This review did not fuzz the program, inspect a live chain state, or provide a formal security certification.
