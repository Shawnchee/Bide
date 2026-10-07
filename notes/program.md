# P lane (program) notes — terse; orchestrator merges into BUILD/SPEC

## STATUS (2026-10-05 15:27 UTC)
- **Local build (not yet on devnet): ALL 28 instructions implemented**, incl. pool (init_pool, pool_deposit,
  pool_withdraw, pool_take_round, pool_lend_idle, pool_unlend, **new `set_pool_params(paused, params)`**),
  flip_plan, update_plan. .so = 823,728 B (< 1,000,000 max-len, upgrade fits without extend).
- **LiteSVM: 20/20 pass** (`pnpm --filter @bide/tests test`), Rust math 6/6, shared + tests `tsc` clean.
  New since last status: wheel (put fill → plan vault → flip_plan → WSOL Lend → call fill), pool (deposit USDC+WSOL,
  lend idle/unlend, PoolWindowNotReached, PoolCapExceeded, PoolPaused, pool_take_round, unwind releases
  reserved/open_notional, in-kind LP withdraw, InsufficientFreeFunds while escrowed), update_plan (size up = extra
  Lend deposit, target down = Lend withdraw-by-amount to owner, tick/horizon/owner checks), and
  **real-VAA post_sample** (`tests/src/pyth-real.test.ts`): 10 genuine mainnet-Hermes SOL/USD updates at consecutive
  10-s bucket starts → real Wormhole HDw2 + receiver rec2 binaries in LiteSVM → tx B = [CU limit, verify_encoded_vaa_v1,
  post_update, **post_sample**, close_encoded_vaa, reclaim_rent] = **109,297 CU**, PriceUpdateV2 closed in the same
  tx; median resolves. Negatives on genuine data: update at bucket_start+1 (prev_publish_time == bucket_start) →
  SampleOutsideBucket; genuine update posted to the wrong bucket → SampleOutsideBucket.
  Fixture: `scripts/fetch-hermes-epoch.ts` → tests/fixtures/pyth/hermes_quick_epoch.json (reuses P2's scripts/pyth/post.ts).
- **On devnet now** (deployed 15:16 UTC, before the "review first" request): the 15-test build — admin, plans
  (create/pause/close/expire), epochs, rounds, settle, unwind; pool/flip/update return `NotImplemented` there.
  Program `4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe`, programdata `aoMRQfch…`, max-len 1,000,000 (5.08 SOL),
  upgrade authority deployer. Deploy tx `4EXzpsotVTtXV9hvoDmHoBZMR8CpJ4HpS69EApgwM3UMDxP9a7m7PHgmf5ezFtgQFqWPF4VZeo7ZxpYiYQyFtm4S`.
  **Upgrade with the full build is pending the Fable review** (one command, ~6 s of SOL fees; buffer rent refunded).
- **Config + SOL asset on devnet** (`scripts/init-devnet.ts`, idempotent, `--update` re-applies params): admin =
  deployer, agent = keeper `CXeiLy…`, fee 1000 bps → demo-user `6f7znm…`; SOL asset PDA
  `ERQdvMiWm4qDFty8xG2NTG8hPPVGZsic9MQJziKH2ujp`, **tick 100_000 ($0.10), max_spot_age_secs 180** (update tx
  `4iCZSDf26y4VyWHNj7UEmfChhNDXzMEaYdXWfStpgb6WYE8n8wSWMPgbhVQQsX2j1vvgJifcPnZiedQ7r7zMwZn1`), conf 50 bps,
  spot move 50 bps, spot feed `7AviUf…`, Lend fToken `BG892…`.
- **ALT** `CEqxacEbFQ2oCJNWtPqQwYBWiyrwsiTakMN786efPoaT` (31 entries; `BIDE_ALT`; `scripts/create-alt.ts`).
  **flip_plan needs it** (legacy tx = 1,363 B > 1,232). create_plan/withdraw/close fit legacy but use v0+ALT anyway.
- **Real devnet Lend CPI proven** (`scripts/smoke-lend.ts`, v0 + ALT): create_plan 1 USDC → 989,790 jlUSDC
  `3omDkJhg7yxmTARKWEpSWcSd6k7SeLXML5W32N4cNA1D8SEvzqKAzkqzNY3u5LwdwoBaWnpMueiPbeSgBkniRK6q`; close_plan
  `4JSVbRFpJEard5Ggh1GxB3ARSKrPFGPFH893vBsr4ERxqvwSBJo5qrF8fpHPSiyGeai7PbiipvVMmL4sPeDSUSm9`.
- IDL account order for pool_take_round / flip_plan / all published instructions is **unchanged** since 15:10.
  Only addition: `set_pool_params` (new ix). Client builders in `@bide/shared` client.ts cover every instruction.
- Not done: pool **call** path test (pool_take_round on a Call round — code path exists, untested), CPI-composability
  test (dummy program), tBTC asset, devnet E2E quick loop with the real keeper (W lane).

## Deviations from BUILD (please merge)
- **Vault ownership:** every plan token account (USDC staging, fToken, asset vault) is owned by the data-less
  PDA `["lend_auth", plan]`, not the Plan PDA (BUILD §3.2 vs §3.7: §3.7 wins). Pool vaults + share-mint authority:
  `["lend_auth", pool]`. Escrow authority = the Round PDA.
- `init_config(agent, fee_bps, fee_recipient)` (BUILD: `init_config(agent)`).
- `Asset` adds `spot_feed: Pubkey` (pins the push-feed account; open/take/pool_take reject any other) and
  `lend_f_token_mint` (default = no Lend, e.g. tBTC). New admin ix `update_asset(params)` (tune spot age/conf/enable).
- `Plan` adds `asset_mint, nonce, band, created_at, lend_auth_bump`. `Round` adds `round_index, escrow_bump`.
  `Epoch.bucket_tolerance_secs` is **u32** (BUILD: u8) so a Plan-B 300 s tolerance fits; adds `grace_secs`.
  `Pool` adds `lend_auth_bump, share_mint_bump`. Share mint PDA `["pool_mint"]`, 6 decimals.
- Extra errors (appended after BUILD §3.4 list): `InvalidAccount, InvalidLendAccounts, NotFullyVerified,
  InvalidPlanParams, NotImplemented`.
- Lend accounts are passed as **remaining accounts**, 13 per market in a canonical order
  (`lendMarketMetas()` in shared/client.ts). flip_plan takes USDC market then asset market (26).
- Token accounts that can alias (owner USDC = fee recipient USDC on devnet; maker = owner) are `UncheckedAccount`
  validated in the handler. Clients create ATAs idempotently in the same tx (builders in client.ts do this).
- Exercised Put delivers **WSOL** to the owner's WSOL ATA (Wheel: plan asset vault). Unwrap is a client concern.
- resolve_round closes the escrow in both outcomes; the Round account closes there if not exercised, else in
  withdraw_collateral. Rent → `rent_payer`.
- withdraw_collateral: if the plan's Lend position is worth < owed (rounding), it redeems all shares and pays
  `min(owed, received)` instead of failing forever.
- Std: auction_secs ∈ [10, 1800], pool_delay 60 s. Quick: auction_secs ∈ [5, 120], pool_delay 10 s.
  open_round requires `now + auction_secs + pool_delay < window_start` for both kinds.
- cancel_round: owner any time in Auction; agent once the pool window opened; anyone 60 s after that.

## Test strategy (orchestrator decision)
LiteSVM (npm `litesvm` 1.5) loaded with the real devnet program ELFs + accounts dumped by
`scripts/dump-fixtures.sh` into `tests/fixtures/` (gitignored). Reason: the program is wall-clock gated and LiteSVM can
set the Clock. Clock rules: always > dumped Lend timestamps, monotonically increasing. Push-feed fixture is
re-written with `publish_time = clock − 10` (real price bytes, shifted time) — a fixture adjustment, not a program mock.

## VERIFY answers (Jupiter Lend, LiteSVM w/ real devnet binaries, 2026-10-05 15:25 UTC)
- **Lend CPI from a data-less PDA signer works** (deposit + redeem, USDC and WSOL markets). lend_auth needs **no
  lamports** when both token accounts are pre-created. `update_rate` CPI first: works (5 accounts, ~8–11k CU).
- **IDL mismatch found:** the deployed devnet Lend requires `liquidity_program` to be **writable** in deposit
  (IDL says readonly) → `ConstraintMut` (2000) otherwise. We pass it writable everywhere (lend.rs + lendMarketMetas).
- Hand-built CPI (no declare_program!) → binds to the program id we pass (LEND_PROGRAM constant check), so the
  IDL's mainnet `address` is irrelevant.
- CU: create_plan (2 idempotent ATAs + transfer + update_rate + deposit) ≈ 143k; close_plan (redeem all) ≈ 105k.
- Share math: 22 USDC deposit → 21,775,173 fTokens (token_exchange_price ≈ 1.0103e12). Redeem-all after 1 h
  returned 21,999,999 → **user loses 1 base unit to rounding** on a full round trip (devnet USDC accrues ~0).
- WSOL market: 0.5 WSOL → 500,000,000 shares (price exactly 1e12 on devnet); round trip exact.
- **withdraw-by-amount from PDA works** (withdraw_collateral, ~125k CU incl. update_rate). Share rounding: burned
  shares are rounded **up** (24.8 USDC → 24,546,560 shares burned at ~1.0103 price), and a plan that deposited
  exactly `notional` was worth `notional − 1` → maker would be 1 unit short. **Fix:** create_plan deposits
  `principal + LEND_DUST_BUFFER (10 base units)`; maker now gets exactly `notional`. Clients wrapping SOL for a Sell
  plan must wrap `size + 10` lamports. Fallback kept: if value < owed, redeem all and pay `min(owed, received)`.
- Lend rejects tiny operations: `OperateAmountsNearlyZero` (Lend error 6028) when redeeming ~10 units.
  close/expire skip the redeem when the position is worth < `LEND_MIN_REDEEM_VALUE` (1,000 base units) — dust stays.
- Exchange-rate read: `Lending.token_exchange_price` @ byte 115 (1e12) after `update_rate` CPI — matches observed
  share math. Used for the shortfall check and (later) pool NAV.

## Phase 1 exit — 2026-10-05 ~15:45 UTC
Full put loop passes on LiteSVM against the real devnet Lend + Pyth receiver binaries (tests/src/putloop.test.ts):
exercised (user gets 0.2 WSOL at strike; maker gets exactly notional via Lend withdraw-by-amount; Round closed;
rest returned on close) and not exercised (escrow back to maker, round+escrow closed, rent → agent).
**Sample caveat:** post_sample is exercised with clones of the real dumped push-feed PriceUpdateV2 (Full) bytes with
`publish_time` shifted into each bucket (fixture adjustment). Posting real Hermes VAAs through rec2… is P2's VERIFY;
the program only reads PriceUpdateV2 (owner rec2…, Full, feed id, publish_time window, conf).

## Oracle decisions applied
- post_sample accepts iff `prev_publish_time < bucket_start ≤ publish_time ≤ bucket_start + tol` (Quick 2 s,
  **Std 10 s**; Std constant changed from 2 → 10). Accounts: asset, epoch, price_update only (fits tx B).
- SOL strike_tick = 100_000 ($0.10) in init script + tests.
- Tests never import `@pythnetwork/pyth-solana-receiver` at runtime.

## More deviations / notes (since 15:20)
- Pool NAV = USDC vault + jlUSDC × Lending.token_exchange_price + WSOL × push-feed spot + reserved (escrowed) value.
  pool_withdraw pays the LP's NAV share **in kind, pro-rata from the free assets** (USDC, jlUSDC fTokens, WSOL);
  fails `InsufficientFreeFunds` if the share exceeds free value. Escrowed funds are not in the vaults (reserved_* tracks them).
- Pool caps in pool_take_round: floor ≤ notional × max_premium_bps; open_notional + notional ≤ max_open_notional;
  (open_notional + notional) ≤ max_utilization_bps × NAV; rolling spend window; free USDC/WSOL ≥ need.
  Round.maker = Pool PDA for pool rounds; escrow returns go to the pool_auth-owned vaults.
- flip_plan: remaining USDC (if worth ≥ 1,000 units) → owner; the asset vault → WSOL Lend; `size_total = held − 10`
  (dust buffer kept so call withdraw-by-amount can't come up short).
- update_plan: rebalances collateral to `ceil(target × remaining)` (Buy/Accumulate) or `remaining` (Sell/Exit);
  excess < 1,000 units is left in place. target/band apply to the side currently traded (exit strike for Sell/Exit).

## Fable review fixes (2026-10-05 15:42 UTC) — local build only, NOT deployed (orchestrator upgrades devnet)
No state account layout changed. .so = 829,744 B (< 1,000,000 max-len). LiteSVM 28/28, Rust 6/6, shared/tests/worker tsc clean.
Regression tests: `tests/src/review-fixes.test.ts`, run on the pre-fix build too with `BIDE_SO=<pre-fix .so>`.
1. **cancel_round escrow donation lock (HIGH):** a non-empty escrow is swept to the **plan owner's** token account of
   the escrow mint, passed as `remaining_accounts[0]` (mint + owner validated), then closed. The IDL account list is
   unchanged. `client.cancelRound(signer, round, r, p?)` appends the owner ATA when `p` is given;
   `client.cancelRoundIxs(...)` also creates that ATA idempotently. resolve_round/unwind_round already moved the full
   `escrow.amount` (surplus goes to the recipient); withdraw_collateral doesn't touch the escrow.
   Pre-fix: WrongStatus (6016). Fixed: passes.
2. **pool_take_round deadline (HIGH):** new account **`epoch`** (`address = round.epoch`). New order:
   `payer, config, asset, plan, round, epoch, escrow, spot_feed, pool, pool_auth, pool_usdc, pool_wsol, lending_usdc,
   owner_usdc, fee_usdc, token_program`. Requires `now ≤ pool_open + 60` (AuctionOver),
   `epoch.status == Open` (EpochNotOpen), `now < window_start` (AuctionOver). Updated shared `client.poolTakeRound`
   and W's `worker/src/chain/anchor.ts` (`epoch: r.epoch`). Pre-fix fails only because the account list differs (3007).
3. **tiny-round brick (MED-HIGH):** open_round requires `notional ≥ MIN_ROUND_NOTIONAL = 1_000_000` → new error
   **`RoundTooSmall` = 6048** (appended; existing codes unchanged). withdraw_collateral withdraws
   `max(need, LEND_MIN_REDEEM_VALUE)` from Lend and pays only `owed`; the surplus stays in vault_staging and is swept by
   close/expire. Pre-fix: a 5-unit residual hits Lend `OperateAmountsNearlyZero` 6028. Fixed: maker paid exactly notional.
4. **pool NAV hole (MED):** an exercised pool round books a receivable at resolve_round (Put: `reserved_usdc += notional`;
   Call: `reserved_wsol += size`), released in withdraw_collateral. **withdraw_collateral's `pool` is now writable**
   (same account list, writability flag only; shared builder unaffected because anchor sets flags from the IDL).
5. **Wheel close strand (MED):** close/expire of a Wheel in Accumulate requires `vault_asset` + `owner_asset`
   (InvalidAccount otherwise). In Exit, the asset vault *is* vault_collateral, so it is swept anyway.
6. **pool inflation (LOW):** virtual shares/assets `POOL_VIRTUAL_OFFSET = 1_000` in deposit and withdraw math.
   Test: attacker deposits 1 unit and donates 1,000 USDC, then a victim deposits 1,500 USDC. Pre-fix the attacker
   withdraws 1,250 USDC (+250). Fixed: the attacker gets 0.000999 USDC back (−1,000) and the victim gets 1,499.80
   (loses 0.2 USDC = 0.013%, the bounded virtual-share rounding cost).

### Known limits (documented, not fixed)
- `fee_bps` changes between open_round and take_round apply at take time (admin-only; a snapshot needs a layout change).
- The keeper can omit ≤ 2 samples (resolve accepts n−2 after grace); mitigated because anyone can post any bucket within grace.
- tBTC call delivery from the pool isn't supported (tBTC not enabled; pool_take_round puts require WSOL).
- cancel_round after a donation needs the owner's escrow-mint ATA to exist. W's keeper calls `client.cancelRound(signer, round, r)`
  **without `p`**, so a donated escrow fails until it passes the plan (or uses cancelRoundIxs). One-line change in W.
