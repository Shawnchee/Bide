# BUILD — Bide build spec (phase by phase)

> Execution plan for the 36h build. `SPEC.md` is the *why*; this file is the *what, exactly*.
> Rules: `HACKATHON.md`. No project code before kickoff (4 oct 2026). Devnet only. $0 budget.
> Anything marked **VERIFY** must be checked in Phase 0 before building on it.

---

## 0. Build principles

1. **Two loops first.** SOL **buy** plan (cash-secured put), then SOL **sell** plan (covered call), end to end on devnet before anything else. Buy loop: create plan → Lend deposit → agent proposes → auction → maker takes → oracle samples → resolve → withdraw → user holds SOL. Full scope ships after it (Phase 7 is required, not stretch — user decision 2026-10-05).
2. **The program is the only guard.** The keeper submits whatever the agents propose, unfiltered. Bounds are enforced on-chain, so a rejection is real (and is our demo's hero moment). No state can depend on the keeper staying alive: every Live round has a permissionless exit (`resolve_round` once the epoch resolves; `unwind_round` if the epoch is Failed).
3. **No mocks — real programs from the first test.** Tests run on **LiteSVM** loaded with the real devnet Jupiter Lend + Liquidity programs and markets, the Pyth receiver and Wormhole guardian accounts (dumped by `scripts/dump-fixtures.sh` into `tests/fixtures/`; decision 2026-10-05 — LiteSVM can set the Clock). Clock always > dumped Lend timestamps and monotonic; push-feed fixture re-written with `publish_time = clock − 10` (real price bytes; a fixture adjustment, not a mock). Trade-off (accepted): if Lend CPI wiring stalls, the whole loop waits on it, so the P lane starts with Lend CPI, not last.
4. **A product, not a demo.** Product defaults everywhere (daily expiries, CEX-priced). The 10-minute "quick plan" is a labelled, opt-in user feature on the same code path — not a separate demo mode.
5. **Record the demo early** (by H26), then improve and re-record.

---

## 1. Repo layout

```
bide/
  Anchor.toml
  programs/bide/src/
    lib.rs                 # instruction entrypoints
    state.rs               # Config, Asset, Plan, Round, Epoch, Pool
    errors.rs
    events.rs
    math.rs                # u128 helpers, auction price, median, decimals
    oracle.rs              # Pyth PriceUpdateV2 checks + normalisation
    lend.rs                # Jupiter Lend deposit/withdraw CPI
    instructions/
      admin.rs             # init_config, add_asset, rotate_agent, set_paused, set_fee
      plan.rs              # create_plan, pause_plan, close_plan, update_plan, expire_plan, flip_plan
      round.rs             # open_round, take_round, cancel_round
      settle.rs            # open_epoch, post_sample, resolve_epoch, resolve_round, withdraw_collateral, unwind_round
      pool.rs              # init_pool, pool_deposit, pool_withdraw, pool_take_round, pool_lend_idle
  tests/                   # TS tests on LiteSVM with real devnet Lend/Pyth/Wormhole binaries + accounts (tests/fixtures/, dumped from devnet)
  packages/shared/         # TS: generated IDL client, types, Black-Scholes, decimals, constants
  worker/                  # Node TS: pricer, makers, keeper, sampler, mirror, desk, agents (maker stances, intake, LLM queue, outcomes), demo (opt-in), http server
  app/                     # Next.js (App Router) + Tailwind + shadcn + wallet adapter; Blink route app/api/actions/plan + actions.json
  scripts/                 # as built: init-devnet (config + SOL asset, --update), create-alt, init-pool, open-round-manual, smoke-lend, integration/ (plans, sigs, state, feed-age, inspect, create/close-plan), pyth/, verify-pyth-*
  supabase/migrations/     # init, waitlist, agents
  keys/                    # gitignored keypairs (already created)
```

Package manager: pnpm workspaces. Node 25 (installed). Anchor CLI 1.0.2, solana-cli 3.1.10 (installed).

---

## 2. Environment variables (never committed; `.env.example` lists names only)

| Name | Used by | Value |
|---|---|---|
| `HELIUS_RPC_URL` | all | Helius devnet RPC (**set** in root `.env`); fallback `https://api.devnet.solana.com` |
| `PROGRAM_ID` | all | Bide program id (devnet) |
| `USDC_MINT` | all | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle devnet) |
| `KEEPER_KEYPAIR` | worker | base58 / JSON of `keys/keeper.json` (agent key) |
| `MAKER1_KEYPAIR`, `MAKER2_KEYPAIR` (+ optional `MAKER3_KEYPAIR`) | worker | maker keys; bot count = number of keys set |
| `PYTH_HERMES_URL` | worker | `https://hermes.pyth.network` (**mainnet** Hermes — its VAAs verify Full on devnet `rec2…`; ✅ 2026-10-05) |
| `PYTH_HERMES_API_KEY` | worker | Hermes key — required (401 without `Authorization: Bearer`). Our key is **not** entitled on `hermes-beta` (403) — not needed |
| `JUP_API_KEY` | worker | optional free Jupiter Portal key (1 RPS); keyless works at 0.5 RPS |
| `ZAI_API_KEY`, `ZAI_BASE_URL` | worker | Z.ai; default `https://api.z.ai/api/paas/v4`, Coding Plan keys `https://api.z.ai/api/coding/paas/v4` (✅ 2026-10-06: **our key is a Coding Plan key** → set the coding URL) |
| `ZAI_MODEL_MAIN`, `ZAI_MODEL_RISK` | worker | `glm-5.3` (✅ listed in docs); risk model defaults to main |
| `CF_ACCOUNT_ID`, `CF_AI_TOKEN`, `CLEF_MODEL` | worker | Cloudflare Workers AI (Clef) — token scoped to Workers AI only; `clef` (default) / `clef-flash` |
| `RISK_BACKEND`, `CLEF_LOCAL_URL` | worker | `workers-ai` (default) / `local` / `glm`; local Clef-flash service URL |
| `DESK_MAX_TOOL_ROUNDS`, `ZAI_TIMEOUT_MS`, `RISK_TIMEOUT_MS`, `QUICK_DESK_LEAD_SECS`, `MAKER_WSOL_TARGET` | worker | optional tuning (defaults 8 rounds, quick desk lead 90 s, maker WSOL 1 SOL) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | worker | server only |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | app | read-only via RLS |
| `WORKER_URL`, `WORKER_SHARED_SECRET` | app → worker | server-side only |
| `QUICK_PLANS_ENABLED` | worker, app | `1` = allow opt-in 10-minute quick plans (on by default for devnet) |
| `MAKER_LLM`, `MAKER_STANCE_LEAD_SECS`, `MAKER_LLM_MAX_PER_HOUR`, `MAKER_LLM_TIMEOUT_MS`, `ZAI_MODEL_AGENTS` | worker | AI maker agents (default on when `ZAI_API_KEY` set; `0` = deterministic bots); lead 240 s; 30 calls/h; model defaults to `ZAI_MODEL_MAIN` |
| `INTAKE_ENABLED`, `INTAKE_MAX_PER_MINUTE`, `INTAKE_TIMEOUT_MS` | worker | natural-language intake (default on, 6/min, 120 s) |
| `DEMO_OWNER_KEYPAIR` | worker | opt-in demo-plan loop (keeps one quick buy + one quick sell plan alive). **Not set on the VM** (pending user decision) |
| `NEXT_PUBLIC_MAKER_BOTS`, `NEXT_PUBLIC_LEND_ALT`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_QUICK_PLANS_ENABLED` | app | maker pubkeys (names on the tape), Lend ALT for v0 txs, browser RPC (unset = public devnet, rate-limited), quick toggle |

Hosted secrets: worker → the ECS VM env file (chmod 600); app → Vercel env vars. Epoch timing (bucket params, `pool_delay_secs`, `grace_secs`) is **code constants per epoch kind** in the program, not env.

---

## 3. On-chain program

### 3.1 Units and math
- USDC: 6 decimals. SOL/WSOL: 9. tBTC: 8.
- **Strike** = USDC base units per **1 whole** asset (e.g. $110 → `110_000_000`).
- **Size** = asset base units (e.g. 0.2 SOL → `200_000_000`).
- **Notional** (USDC base units) = `strike × size / 10^asset_decimals`, computed in **u128**, rounded **down** for amounts the user pays out and **up** for amounts the user must lock.
- Pyth price → USDC base units: `price × 10^(6 + expo)` (expo is negative), u128, checked.
- All arithmetic `checked_*`; any overflow → `MathOverflow`.

### 3.2 Accounts

**`Config`** — seeds `["config"]`
| Field | Type | Notes |
|---|---|---|
| admin | Pubkey | deployer |
| agent | Pubkey | keeper/agent key; rotatable |
| paused | bool | global kill switch |
| fee_bps | u16 | **platform fee**, % of every premium (default 1000 = 10%; hard cap 2000 = 20% in code) |
| fee_recipient | Pubkey | fee wallet; **devnet: demo-user**; fees go to its USDC ATA. Changeable later with `set_fee` |
| bump | u8 | |

**`Asset`** — seeds `["asset", mint]`
| Field | Type | Notes |
|---|---|---|
| mint | Pubkey | WSOL / tBTC |
| decimals | u8 | |
| pyth_feed_id | [u8; 32] | Hermes ids (checked 2026-10-05): SOL/USD `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`, BTC/USD `e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| spot_feed | Pubkey | pins the push-feed account (§3.7); `open_round` / `take_round` / `pool_take_round` reject any other (`WrongFeed`) |
| lend_f_token_mint | Pubkey | Lend fToken mint for this asset's market; default = no Lend (tBTC) |
| strike_tick | u64 | USDC base units. **SOL $0.10 → 100_000** (decision 2026-10-05: a $1 tick ≈ 5σ for a 10-min quick epoch); BTC $250 |
| max_conf_bps | u16 | reject Pyth samples with conf/price above this (e.g. 50) |
| max_spot_move_bps | u16 | auction spot guard (e.g. 50 = 0.5%) |
| max_spot_age_secs | u32 | push-feed staleness limit: **devnet 300** (raised 2026-10-06 after feed gaps of 227–320 s blocked takes; ~~180~~ 2026-10-05), mainnet 30. Weaker spot guard on devnet — README limits |
| enabled | bool | |
| bump | u8 | |

**`Plan`** — seeds `["plan", owner, plan_nonce: u64 LE]`
| Field | Type | Notes |
|---|---|---|
| owner | Pubkey | |
| asset | Pubkey | Asset PDA |
| asset_mint / nonce / created_at | Pubkey / u64 / i64 | |
| band | u64 | user's allowed strike band (0 if locked) |
| side | enum { Buy, Sell, Wheel } | Buy = puts; Sell = covered calls (collateral = asset, WSOL into Lend for SOL; tBTC sits idle); Wheel = puts until filled, then calls at `exit_strike` |
| exit_strike | u64 | Sell/Wheel only: the user's sell price |
| exit_band | u64 | Sell/Wheel only: allowed upward nudge for calls (0 if locked) |
| call_strike_min / call_strike_max | u64 | calls: `[exit_strike, exit_strike + exit_band]` (only higher = better for the user); if locked, both = exit_strike |
| phase | enum { Accumulate, Exit } | Wheel flips Accumulate → Exit after the puts fill (`flip_plan`, agent-signed, bounds unchanged) |
| quick | bool | `create_plan` arg; quick plans may only join Quick epochs, others only Std epochs |
| target_strike | u64 | user's price |
| lock_strike | bool | default **true** |
| strike_min / strike_max | u64 | Buy: `[target − allowed_band, target]` (only lower = better for the user); if locked, both = target |
| size_total / size_filled | u64 | asset base units |
| collateral_principal | u64 | principal deposited: USDC (= notional at target, rounded up) for Buy/Accumulate; asset units for Sell/Exit |
| lend_shares | u64 | fToken amount held by the plan vault. **Reused per phase:** USDC fTokens in Accumulate, WSOL fTokens in Exit — a plan only ever holds one Lend market at a time |
| pending_settlement | Option<Pubkey> | set by `resolve_round` when a round is exercised; cleared by `withdraw_collateral`. While `Some`, `open_round` / `close_plan` / `update_plan` / `expire_plan` / `flip_plan` fail with `SettlementPending` (closes the close-before-pay race) |
| min_premium_bps_per_day | u16 | **user-signed, mandatory**, e.g. 10 = 0.10%/day of notional |
| max_expiry_secs | u32 | longest round allowed |
| horizon_end | i64 | user's "by when" deadline; `create_plan` requires `now + 1 day ≤ horizon_end ≤ now + 180 days` (quick plans: ≥ now + 10 min) |
| max_rounds_per_day | u8 | e.g. 6 (quick plans: 30 — note this caps a quick plan at ~5 h of 10-min rounds per day) |
| rounds_today / day_index | u8 / u32 | rate limit |
| round_count | u32 | next round index |
| active_round | Option<Pubkey> | at most one live round |
| paused | bool | user-controlled |
| status | enum { Active, Filled, Closed } | |
| bump / lend_auth_bump | u8 / u8 | |

**`Round`** — seeds `["round", plan, round_index: u32 LE]`
| Field | Type | Notes |
|---|---|---|
| plan, asset | Pubkey | |
| round_index | u32 | |
| kind | enum { Put, Call } | Put: maker escrows asset, user's USDC (jlUSDC) is the payment side. Call: maker escrows `notional` USDC, user's asset (jlWSOL for SOL) is the delivery side; exercised iff `settle_price > strike` |
| strike, size, notional | u64 | |
| epoch | Pubkey | the Epoch this round belongs to |
| expiry | i64 | = epoch.expiry |
| auction_start | i64 | = open time |
| auction_secs | u32 | e.g. 30 |
| pool_delay_secs | u32 | copied from the epoch kind's code constant; pool may take after `auction_start + auction_secs + pool_delay_secs` |
| rent_payer | Pubkey | who paid the Round + escrow rent (agent/keeper); receives it back when the Round and escrow are closed on Settled / Unwound / Cancelled / Resolved-not-exercised |
| premium_start / premium_floor | u64 | USDC base units, total for the round |
| spot_at_open | u64 | Pyth spot (USDC units) read in `open_round` |
| maker | Pubkey | default = none |
| maker_is_pool | bool | |
| premium_paid | u64 | gross premium |
| fee_paid | u64 | platform fee taken from it |
| exercised | u8 | 0 = unknown, 1 = no, 2 = yes |
| settle_price | u64 | copied from epoch |
| memo_hash | [u8; 32] | sha256 of the desk memo |
| status | enum { Auction, Live, Cancelled, Resolved, Settled, Unwound } | |
| bump / escrow_bump | u8 / u8 | |

**`Epoch`** — seeds `["epoch", asset, kind: u8, expiry: i64 LE]` — **all rounds for one asset + kind + expiry share it** (decision 2026-10-05; `kind` in the seeds so a quick epoch can never collide with a std epoch at the same timestamp)
| Field | Type | Notes |
|---|---|---|
| asset | Pubkey | |
| kind | enum { Std, Quick } | Std = daily / weekly / monthly; Quick = 10-min epochs for quick plans |
| expiry | i64 | schedule: Std daily 08:00 UTC; weekly + monthly = Friday 08:00 UTC (Deribit convention); Quick: every 10 min |
| n_buckets / bucket_secs / bucket_tolerance_secs / grace_secs | u8 / u32 / **u32** / u32 | copied from the kind's code constants: n 10; bucket Std 180, Quick 10; tolerance **Std 10, Quick 2**; grace Std 3600, Quick 120 |
| samples / sample_mask | [u64; 10] / u16 | Pyth samples, **posted once per epoch** |
| settle_price | u64 | median, set by `resolve_epoch` |
| status | enum { Open, Sampling, Resolved, Failed } | Failed = not enough samples by `expiry + grace_secs` |
| bump | u8 | |

Window: `window_start = expiry − n_buckets × bucket_secs`. Bucket i starts at `window_start + i × bucket_secs`.

**Auction window + schedule — code constants per kind (no stored `auction_open/close`):**
- **Std:** `open_round` allowed iff `(now − 08:00 UTC) mod 86400 < 1800` (first 30 min after 08:00 UTC each day) and `expiry − now ≥ 12 h`. `auction_secs` ∈ [10, 1800], `pool_delay_secs` 60.
- **Quick:** `open_round` allowed iff `now ∈ [expiry − 600, expiry − 540]` (first 60 s of the 10-min epoch). `auction_secs` ∈ [5, 120], `pool_delay_secs` 10.
- Both kinds: `now + auction_secs + pool_delay_secs < window_start` (else `AuctionParamsInvalid`).
- `open_epoch` schedule check: Std `expiry mod 86400 == 28800`; Quick `expiry mod 600 == 0`; both `expiry ≤ now + 180 d`.
- Bucket params, `pool_delay_secs`, `grace_secs` = code constants per kind (`programs/bide/src/constants.rs`; mirrored in `@bide/shared` `EPOCH_PARAMS`).
- ✅ 2026-10-05: Hermes publishes **1 update per second, gap-free** (`prev_publish_time = publish_time − 1`), so Quick 2 s tolerance always has a sample; acceptance rule in §3.3 #9.

**`Pool`** — seeds `["pool"]`
| Field | Type | Notes |
|---|---|---|
| authority | Pubkey | deployer |
| max_premium_bps_of_notional | u16 | e.g. 150 = 1.5% max premium per round |
| max_open_notional | u64 | USDC units |
| max_utilization_bps | u16 | max % of pool NAV reserved at once |
| spend_window_secs / spend_window_start / spend_window_cap / spend_window_spent | u32 / i64 / u64 / u64 | rolling premium spend cap (e.g. daily); named "spend window" to avoid confusion with `Epoch` |
| paused | bool | pool kill switch (deposits + `pool_take_round`) |
| share_mint | Pubkey | SPL mint for LP shares — PDA `["pool_mint"]`, 6 decimals |
| lend_shares | u64 | USDC fTokens held by the pool (`pool_lend_idle`) |
| reserved_usdc / reserved_wsol | u64 | funds outside the vaults: live escrows (calls reserve USDC, puts reserve WSOL) **plus** receivables of exercised pool rounds until `withdraw_collateral` (put → USDC notional, call → WSOL size) |
| open_notional | u64 | covers puts **and** calls; incremented in `pool_take_round`; **decremented** in `resolve_round` / `unwind_round` when `maker_is_pool` |
| bump / lend_auth_bump / share_mint_bump | u8 | |
| put_open_size / put_open_notional | u64 / u64 | **v2 (2026-10-07, appended)**: Σ size (WSOL escrowed) and Σ strike notional (USDC) of LIVE pool puts |
| call_open_notional / call_open_size | u64 / u64 | **v2**: Σ notional (USDC escrowed) and Σ size (WSOL owed on exercise) of LIVE pool calls. All four: += in `pool_take_round`, −= in `release_pool` (resolve_round / unwind_round) |

Size: 8 + 172 = **180 bytes** (v1 was 148; the devnet pool initialised 2026-10-06 is v1 → run `migrate_pool` right after the upgrade, before any pool instruction).
**NAV** (`pool_nav`, decision 2026-10-07): USDC vault + Lend USDC + WSOL vault × spot + put leg `max(spot × put_open_size, put_open_notional)` + call leg `max(call_open_notional, spot × call_open_size)` + receivables (`reserved_usdc − call_open_notional` at face, `(reserved_wsol − put_open_size) × spot`). Live pool options are thus marked at intrinsic value, so shares minted between `resolve_epoch` and `resolve_round` can't buy the already-known payoff cheap (codex_v2 P1).

**Token accounts (all PDA-owned)** — as built 2026-10-05
- Plan vaults: **every** plan token account (USDC staging, fToken, asset vault — tBTC sits in the asset vault as a plain vault) is owned by the data-less `["lend_auth", plan]` PDA, not the Plan PDA (§3.7 pattern).
- Round escrow: token account seeds `["escrow", round]`, **authority = the Round PDA**; **escrow mint = asset (Put) / USDC (Call)**. Closed in `resolve_round` (both outcomes); rent → `rent_payer`.
- Pool vaults (USDC, WSOL; + tBTC later) and share-mint authority: `["lend_auth", pool]`.
- Token accounts that can alias (owner USDC = fee-recipient USDC on devnet; maker = owner) are `UncheckedAccount`, validated in the handler. Clients create ATAs idempotently in the same tx (`@bide/shared` client builders do).

### 3.3 Instructions

**Status update 2026-10-07:** 29th instruction `migrate_pool` (#14e) + pool NAV intrinsic marking (codex_v2 P1) in source, LiteSVM 43/43 + `cargo test` 12/12; **not deployed yet** — upgrade, then `migrate_pool` before any pool instruction.

**Status update 2026-10-06:** all 28 instructions implemented (incl. pool, `flip_plan`, `update_plan`) and deployed with the Fable review fixes (devnet slot 507875135); 28/28 LiteSVM tests. Devnet proven (tx links: README §5): buy not exercised, **buy exercised + `withdraw_collateral`**, sell not exercised, **sell exercised + `withdraw_collateral`**, `expire_plan`, `unwind_round`, `cancel_round`, AI-desk-opened rounds (one exercised), on-chain rejections `AuctionParamsInvalid` / `OutsideAuctionWindow` / `StalePrice` (the last two are timing, not bound violations); `init_pool` + `pool_deposit` (6 Oct 09:57); live std call round `5Ccfmg…` settles 7 Oct 08:00 UTC. Not yet on devnet: `flip_plan`, `update_plan`, `pool_take_round`, `pool_withdraw` (LiteSVM only). ~~**Status 2026-10-05 15:45 UTC (27 ixs, IDL in `packages/shared/src/idl/`):** implemented — admin (#1–3 incl. `update_asset`), `create_plan` (Buy/Sell/Wheel), `pause_plan`, `close_plan`, `expire_plan`, `open_epoch`, `open_round`, `take_round`, `cancel_round`, `post_sample`, `resolve_epoch`, `resolve_round`, `withdraw_collateral`, `unwind_round`. **Layout frozen, handler returns `NotImplemented`** (ships via program upgrade): `update_plan`, `flip_plan`, `pool_take_round`, `init_pool`, `pool_deposit`, `pool_withdraw`, `pool_lend_idle`, `pool_unlend` (marked ⏸ below).~~ (The ⏸ marks below are historical: every instruction is implemented and deployed.)

| # | Instruction | Signer | Key checks | Effects |
|---|---|---|---|---|
| 1 | `init_config(agent, fee_bps, fee_recipient)` | admin | once; `fee_bps ≤ 2000` | creates Config |
| 2 | `add_asset(params)` / `update_asset(params)` | admin | `InvalidMint` if mint/decimals mismatch | creates Asset (incl. `spot_feed`, `lend_f_token_mint`) / tunes `strike_tick`, spot age, conf, move guard, `enabled` |
| 3 | `rotate_agent(new)` / `set_paused(b)` / `set_fee(fee_bps, fee_recipient)` | admin | `fee_bps ≤ 2000` (`FeeTooHigh`) | |
| 4 | `create_plan(nonce, side, quick, target_strike, exit_strike, size_total, lock_strike, band, exit_band, min_premium_bps_per_day, max_expiry_secs, horizon_end, max_rounds_per_day)` | user | asset enabled; strikes % tick == 0; `size_total > 0` (`ZeroAmount`); `min_premium_bps_per_day > 0`; horizon range (`HorizonOutOfRange`; quick plans: ≥ now + 10 min) | **Buy / Wheel:** transfers `collateral_principal` + `LEND_DUST_BUFFER` (10 base units) USDC from user → `update_rate` CPI → **Lend deposit CPI** → fTokens to plan vault (the buffer covers Lend's round-up on withdraw-by-amount, so the maker gets exactly `notional`). **Sell:** transfers `size_total` + 10 asset (client wraps `size + 10` lamports into WSOL in the same tx) → **WSOL Lend deposit CPI** (tBTC: plain plan asset vault, no Lend). Lend accounts = remaining accounts, 13 per market in canonical order (`lendMarketMetas()` in `@bide/shared` client). Stores `lend_shares`; emits `PlanCreated`. ~143k CU |
| 4b | `open_epoch(asset, kind, expiry)` | anyone (keeper on schedule) | schedule check per kind (Std `expiry mod 86400 == 28800`; Quick `expiry mod 600 == 0`; `expiry ≤ now + 180 d`) else `InvalidSchedule`; not already created | creates Epoch (status Open) with the kind's bucket constants; emits `EpochOpened` |
| 5 | `open_round(round_index, strike, size, auction_secs, premium_start, premium_floor, memo_hash)` + Epoch account + Pyth **sponsored push-feed** account | **agent** | not paused (global/plan); no active round; **`plan.pending_settlement == None`** (`SettlementPending`); round kind = Put if plan is Buy / Wheel-Accumulate, Call if Sell / Wheel-Exit; strike in `[strike_min, strike_max]` (Put) or `[call_strike_min, call_strike_max]` (Call) and on tick; size ≤ remaining; epoch status Open; **`epoch.kind == (plan.quick ? Quick : Std)`** (`EpochKindMismatch`); `now` inside the kind's auction window (§3.2 constants, `OutsideAuctionWindow`); `epoch.expiry ≤ min(now + max_expiry_secs, horizon_end)`; rate limit; **`premium_floor × (10_000 − fee_bps) / 10_000 ≥ notional × min_premium_bps_per_day × secs_to_expiry / (86_400 × 10_000)`** (user's minimum is checked **after** our fee); `0 < premium_floor ≤ premium_start ≤ 3 × premium_floor`; `auction_secs` in the kind's range and `now + auction_secs + pool_delay_secs < window_start` (`AuctionParamsInvalid`); spot from the push feed = `asset.spot_feed` (`WrongFeed`; ≤ `asset.max_spot_age_secs`, conf ok) | creates Round (status Auction, `rent_payer` = signer, `pool_delay_secs` from the kind constant), stores `spot_at_open`, emits `RoundOpened{memo_hash}` |
| 6 | `take_round()` + Pyth push-feed account | maker | status Auction; `now ≤ auction_start + auction_secs + pool_delay_secs`; spot ≤ `asset.max_spot_age_secs` old; **spot guard: \|spot − spot_at_open\| ≤ max_spot_move_bps**; price = `auction_price(now)` | maker pays premium: **fee = premium × fee_bps / 10_000 → `fee_recipient` USDC ATA**, rest → user's USDC ATA (both created idempotent, maker pays rent); `round.fee_paid` stored; maker escrows **`size` asset (Put) or `notional` USDC (Call)** into round escrow; status Live |
| 7 | ⏸ `pool_take_round()` + Pyth push-feed account | anyone | pool not paused (`PoolPaused`); status Auction; `now ≥ auction_start + auction_secs + pool_delay_secs`; spot guard; premium = `premium_floor`; `premium_floor ≤ notional × max_premium_bps_of_notional / 10_000`; spend-window cap; open-notional cap; `max_utilization_bps`; free (unreserved) USDC/WSOL ≥ need (`InsufficientFreeFunds`) | same as take_round, funded from pool vaults (premium from USDC; escrow from WSOL for Puts, USDC for Calls); `reserved_usdc`/`reserved_wsol` += escrow; `open_notional += notional` (puts and calls); put/call open sums += (v2); `maker_is_pool = true`. SOL rounds only (puts and, since 2026-10-07, calls: `InvalidMint`) |
| 8 | `cancel_round()` | plan owner any time in Auction; agent once the pool window opened (`auction_start + auction_secs + pool_delay_secs`); **anyone** 60 s after that | status Auction | status Cancelled; clears `active_round`; closes Round + escrow (rent → `rent_payer`); emits `RoundCancelled` |
| 9 | `post_sample(bucket)` on the **Epoch** + Pyth PriceUpdateV2 | anyone | epoch Open/Sampling; `now ≤ expiry + grace_secs`; bucket < n; not already filled; PriceUpdateV2 **owned by `rec2…`** (`WrongFeed`; pro-compatible receiver SDK); feed id matches; **`VerificationLevel::Full`** (`NotFullyVerified`; encoded-VAA path); **`prev_publish_time < bucket_start ≤ publish_time ≤ bucket_start + tolerance`** (`SampleOutsideBucket`) = the unique first update at/after bucket start, so a poster can't pick among prints (tolerance Quick 2 s, Std 10 s). The receiver does **no** age check (any old VAA is postable), so this window check is the only defence; conf ≤ max_conf_bps | stores normalised price on the Epoch, sets mask bit, Open → Sampling (one set of samples serves every round in the epoch) |
| 9b | `resolve_epoch()` | anyone | — | if **all n** filled and `now ≥ expiry`, **or** filled ≥ n − 2 and `now ≥ expiry + grace_secs` (posting closed, so no one can resolve early and skip unfavourable late samples) → `settle_price = median(samples)`, status Resolved, emits `EpochResolved`; else if `now ≥ expiry + grace_secs` (and < n − 2 filled) → status **Failed**, emits `EpochFailed`; else error `NotEnoughSamples` |
| 10 | `resolve_round()` | anyone | status Live; epoch Resolved | `settle_price = epoch.settle_price`. **Put** exercised iff `settle_price < strike`: escrow asset → user's asset ATA (Wheel: plan asset vault), `plan.size_filled += size`. **Call** exercised iff `settle_price > strike`: escrow USDC → user's USDC ATA, `plan.size_filled += size`; the asset reaches the maker via #11 (withdraw-by-amount of `size`). **Exercised:** `plan.pending_settlement = Some(round)`. Put delivery is **WSOL** to the owner's WSOL ATA (unwrap = client). Escrow is closed in both outcomes. **Not exercised:** escrow → maker (or pool); close Round + escrow (rent → `rent_payer`). If `maker_is_pool`: `pool.open_notional −= notional`, release `reserved_*`. Status Resolved; clears active_round; plan Filled if fully filled (Wheel stays Active for `flip_plan`) |
| 11 | `withdraw_collateral()` | anyone | status Resolved & exercised | `update_rate` CPI, then **Lend withdraw-by-amount** (~125k CU) of exactly `notional` (Put, USDC market) or `size` (Call, WSOL market; tBTC: plain vault transfer); shares burned rounded **up**; if the position is worth < owed (rounding), redeem all and pay `min(owed, received)` instead of failing forever; `plan.lend_shares −= burned`; `plan.collateral_principal −= owed`; yield stays in Lend until `close_plan` / `expire_plan`. **Retryable** if Lend blocks. Clears `plan.pending_settlement`; status Settled; closes Round + escrow (rent → `rent_payer`); emits `CollateralWithdrawn` |
| 12 | `pause_plan(b)` | owner | | |
| 12b | ⏸ `flip_plan()` | agent | Wheel plan (`NotWheelPlan`); phase Accumulate (`WrongPhase`); **`size_filled == size_total`**; no active round; `pending_settlement == None` | withdraws all remaining USDC fTokens (unused collateral + yield) **to the owner**, then deposits the plan's asset vault into **WSOL Lend** — a plan only ever holds one Lend market. `lend_shares` = new WSOL shares; `collateral_principal` = asset deposited; `size_total` = asset held, `size_filled = 0`; phase Exit; emits `PlanFlipped`. Remaining accounts: USDC Lend market (13) then asset market (13). For Wheel plans, `resolve_round` sends an exercised put's asset to the **plan's asset vault** (not the user's ATA) so it can back the calls; user can still `close_plan` between rounds to take it |
| 13 | `close_plan()` | owner | no Live/Auction round; `pending_settlement == None` | Lend redeem all (+ plan asset vault) → user; skips the redeem if the position is worth < `LEND_MIN_REDEEM_VALUE` (1,000 base units; Lend rejects tiny ops with `OperateAmountsNearlyZero` 6028) — dust stays; status Closed; emits `PlanClosed`. ~105k CU |
| 13a | ⏸ `update_plan(target_strike?, band?, horizon_end?, min_premium_bps_per_day?, size_total?)` | owner | no Live/Auction round; `pending_settlement == None`; same checks as `create_plan`; size increase → extra deposit + Lend CPI, decrease → Lend withdraw to user | recompute `strike_min/max`, collateral; emits `PlanUpdated` |
| 13b | `expire_plan()` | **anyone** | `now ≥ horizon_end` (`PlanNotExpired`); no Live/Auction round; `pending_settlement == None` | same as `close_plan` (funds go to the owner only); status Closed; emits `PlanExpired`. Keeper calls it; anyone can if the keeper is down |
| 14 | ⏸ `init_pool(params)` | pool authority | once | creates Pool, vaults, share mint |
| 14b | ⏸ `pool_deposit(mint, amount)` + Pyth push-feed account + Lend exchange-rate account | **anyone (LP)** | pool not paused (`PoolPaused`); `amount > 0`; mint ∈ {USDC, WSOL} (`InvalidMint`) | mints shares at **NAV = USDC vault + Lend USDC (`lend_shares` × Lend exchange rate) + WSOL × Pyth spot + live pool options at intrinsic value + receivables** (§3.2 Pool; round shares down); emits `PoolDeposited` |
| 14c | ⏸ `pool_withdraw(shares)` | LP | payout ≤ unreserved funds (`InsufficientFreeFunds`) | burns shares, pays **in kind**, pro-rata from unreserved USDC (`vault − reserved_usdc`) and unreserved WSOL (`vault − reserved_wsol`); emits `PoolWithdrawn` |
| 14d | ⏸ `pool_lend_idle(amount)` / `pool_unlend(amount)` | pool authority or keeper | keep ≥ X% liquid for the next round | parks idle pool USDC in Jupiter Lend; updates `pool.lend_shares` |
| 14e | `migrate_pool()` (2026-10-07) | **config admin** (pays rent) | pool PDA owned by the program, Pool discriminator, length == 148 (v1) else `WrongStatus` (one-shot) | grows the v1 Pool account to 180 bytes in place; the v2 open-option sums start at 0 (devnet pool had no take). Client: `BideClient.migratePool(admin)` |
| 15 | `unwind_round()` | **anyone** | status Live; **`epoch.status == Failed` only** (no time-based path — a resolvable epoch can't be front-run into an unwind) | escrow → maker (or pool vault); no exercise; premium stays with the user; if `maker_is_pool`: `pool.open_notional −= notional`, release `reserved_*`; clears `active_round`; status Unwound; closes Round + escrow (rent → `rent_payer`); emits `RoundUnwound`. Collateral never left Lend, so nothing else to move. |
| 16 | `create_plan` CPI-callable | any program | same checks; owner must sign | no extra code — documented + one test where a dummy program opens a plan via CPI ("paid limit order" primitive) |


**Spec fixes (Fable 5.1 review, 2026-10-05) — reconciled with what P built:**
- Pyth Rust: push feeds **and** posted PriceUpdateV2 are **owned by the receiver `rec2…`**, not the push program. Built: `pyth-solana-receiver-sdk` 2.0.0 with `features = ["pro-compatible"]` (→ `rec2…`; default is `rec5…`), plus an explicit owner check (`oracle.rs`), `verification_level == Full`, and our own `publish_time` checks.
- Exercised Put delivers **WSOL** to the user's WSOL ATA (Wheel: plan asset vault); the UI offers unwrap.
- Auction params: Std `auction_secs` ∈ [10, 1800], Quick [5, 120]; `pool_delay_secs` Std 60 / Quick 10 (§3.2). The first `post_sample` flips the Epoch Open → Sampling.
- `withdraw_collateral` owes `notional` at the round strike, which can be < `collateral_principal`; the excess stays in Lend until `close_plan` / `expire_plan`.
- Vault ownership: all plan token accounts under `["lend_auth", plan]` (§3.2 token accounts).
- ~~Deferred inside the P lane: pool instructions, `flip_plan`, `update_plan`~~ — implemented and deployed 2026-10-05. Still to do: tBTC, CPI-composability test (ALT done: `CEqxacEb…`).
- Tripwires: ~~Lend CPI deposit+withdraw on LiteSVM by 6 Oct 00:00 UTC~~ ✅ met 2026-10-05 15:25 UTC. ~~Pyth Plan A verdict by 5 Oct 18:00 UTC~~ ✅ met 15:20 UTC (Plan A passes). Buy loop not end-to-end on devnet by 7 Oct 00:00 UTC → feature freeze. 6 Oct 08:00 UTC window only if create/open/take pass on LiteSVM by 6 Oct 04:00 UTC (✅ passed on LiteSVM 15:45 UTC; still needs the devnet deploy).

**Auction price:** `elapsed = clamp(now − auction_start, 0, auction_secs)`; `price = premium_start − (premium_start − premium_floor) × elapsed / auction_secs` (u128). After `auction_secs`, price = floor until the pool window.

**Median:** sort filled samples (≤ 10) in place; even count → mean of middle two.

**Constants:** no `SAMPLE_SETTLE_SECS` — the keeper normally fills all n buckets, so epochs resolve right at expiry; a partially filled epoch waits until posting closes at `expiry + grace_secs`; `grace_secs` per epoch kind (§3.2).

**Compute:** request a **400k CU limit** on every tx that does a Lend CPI (`create_plan`, `withdraw_collateral`, `flip_plan`, `close_plan`, `update_plan`, `expire_plan`, `pool_lend_idle`/`pool_unlend`). Measured on LiteSVM: `create_plan` ≈ 143k, `withdraw_collateral` ≈ 125k, `close_plan` ≈ 105k, Pyth verify + post_update ≈ 101k.

### 3.4 Errors
`EpochNotOpen, OutsideAuctionWindow, EpochNotResolved, GraceNotElapsed, PlanNotExpired, Paused, PlanPaused, AssetDisabled, StrikeOutOfBounds, StrikeOffTick, SizeTooLarge, ExpiryOutOfBounds, RateLimited, PremiumBelowUserMin, AuctionParamsInvalid, ActiveRoundExists, WrongStatus, AuctionOver, PoolWindowNotReached, SpotMovedTooMuch, StalePrice, PriceConfidenceTooWide, WrongFeed, BucketOutOfRange, BucketFilled, SampleOutsideBucket, NotEnoughSamples, NotExpired, PoolCapExceeded, MathOverflow, Unauthorized, FeeTooHigh, InvalidSchedule, HorizonOutOfRange, PoolPaused, InsufficientFreeFunds, InvalidMint, ZeroAmount, EpochFailed, SettlementPending, EpochKindMismatch, NotWheelPlan, WrongPhase`, then (added by P) `InvalidAccount, InvalidLendAccounts, NotFullyVerified, InvalidPlanParams, NotImplemented`.

### 3.5 Events
`PlanCreated, RoundOpened{memo_hash}, RoundTaken{maker, premium, fee, is_pool}, EpochOpened, SamplePosted, EpochResolved, RoundResolved{settle_price, exercised}, CollateralWithdrawn, RoundCancelled, RoundUnwound, PlanUpdated, EpochFailed, PlanFlipped, PlanClosed, PlanExpired, PoolDeposited, PoolWithdrawn`.

### 3.6 Integrations
- **Jupiter Lend Earn (devnet):** lending program `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3`, USDC fToken `2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu`, WSOL fToken `BG892DUQW1NHQLinc4mabqH7EVeEfFWpVibAiNnggwmU`. The Lend SDK is mainnet-only (§3.7), so the client builds the accounts itself (`lendMarketMetas()` in `@bide/shared`: 13 per market, canonical order) and passes them as `remaining_accounts`; the program CPIs by hand with the documented discriminators (no `declare_program!`). `withdraw_collateral` uses **withdraw-by-amount** (exact `notional` / `size`). ✅ 2026-10-05 (LiteSVM, real devnet binaries): withdraw-by-amount works from the PDA; burned shares round **up** (→ `LEND_DUST_BUFFER`); exchange rate = `Lending.token_exchange_price` (also used by pool NAV). Put the Lend accounts in an **address lookup table** (not built yet).
- **Pyth:** `pyth-solana-receiver-sdk` 2.0.0 (Rust, `pro-compatible` feature → `rec2…`) to read `PriceUpdateV2`. Hermes = **mainnet `hermes.pyth.network`** (key). Historical updates per bucket via `GET /v2/updates/price/{t}?ids[]=…&encoding=base64&parsed=true` → ✅ returns `publish_time` exactly `t` (1 Hz, no gaps; 404 if `t` is too recent or older than ~180 d). Samples go on the **encoded-VAA path** (`VerificationLevel::Full`) and the update accounts are closed in the same tx.
  - **JS SDK `@pythnetwork/pyth-solana-receiver` 0.16 is unusable under Node 25** (ESM build pulls `jito-ts` → web3.js 1.77 → `ERR_PACKAGE_PATH_NOT_EXPORTED`). Use the hand-built receiver ixs in `scripts/pyth/post.ts` (`postFullUpdate`, `buildFullUpdate`, `closeUpdate`, `decodePriceUpdateV2`, `pushFeedAddress`; worker copy `worker/src/pyth/post.ts`) and `scripts/pyth/hermes.ts`. Only the SDK's `.../address` subpath (`PRO_COMPATIBLE_*` ids) imports cleanly.
- **Pyth spot for auctions:** `open_round` / `take_round` / `pool_take_round` / `pool_deposit` read the Pyth **sponsored push-feed** account (max age `Asset.max_spot_age_secs` (devnet 180 s)), so `/maker` takers and LPs never need to post VAAs. ✅ 2026-10-05: SOL/USD and BTC/USD shard-0 addresses match §3.7 (owner `rec2…`, Full); cadence ~60–70 s (§3.7 finding 1).
- ~~**Lend plan B (emergency only, SPEC §14):** user deposits USDC → jlUSDC client-side with a Jupiter SDK instruction in the same transaction as `create_plan`; the program takes jlUSDC as collateral (no CPI, no ALT). On exercise, pay the maker jlUSDC worth `K × Q` at the current exchange rate. Jupiter integration stays real.~~ Not needed — Lend CPI from a PDA verified 2026-10-05.
- **No mocks.** Localnet = real devnet programs cloned; devnet = the real thing.

---

### 3.7 Verified devnet addresses (checked on-chain 2026-10-05 — Phase 0 still re-checks)

**Jupiter Lend** — **the `@jup-ag/lend` SDK has no devnet option** (hardcoded mainnet ids; `getDepositContext` on devnet returns mainnet accounts). Build the CPI from the IDLs in `research/lending_idl.json` + `research/liquidity_idl.json` with these devnet ids.

| Account | USDC market | WSOL market |
|---|---|---|
| Earn (lending) program | `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3` | same |
| Liquidity program | `5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL` | same |
| Rewards rate model program | `68LHLkpgjAvo6Lgd9FT6KYEX4FWn1911EohSXxHYMFjc` | same |
| lending_admin (`["lending_admin"]`) | `DeF2BVMjWdCamK71nqBZ7uzQkLeW9MJ6C7zoCKLJXEmW` | same |
| liquidity PDA (`["liquidity"]`) | `DFHSbFzMU67yHK9yLsLBLso7aEnzrB4ZQR7KBujmSU3M` | same |
| mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `So11111111111111111111111111111111111111112` |
| f_token_mint | `2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu` | `BG892DUQW1NHQLinc4mabqH7EVeEfFWpVibAiNnggwmU` |
| lending | `98Uy7eonumvRbhQvP5Jt7B3WjNqpndioMF99xvR7sDVa` | `GAvizzttfkgetRzkZY9fqzCYo3fJULM7E9V1Gq5CVTNS` |
| reserve | `644Eh222dNe1V6sSRkYHBcdpxfjtxBBptAJ6mZujRRNo` | `BA6Sg5PUACHHUgK9emXGLdLXEVuPvWGZADo5ZqTLqVi1` |
| rate_model | `CpSRFppSpkdPw7juvRpSxwVyZMN3y8g7cHXCbrc3MBUs` | `HNT4VUeaBaBMqqCa1oJWwG8g1TApZfAJR6e34h9JL5c1` |
| supply_position | `B5JAZXGKaZfWsUrauprZVNQM7HwXN8AfKVTt25qtDKYV` | `Gi2KLaG18VZYF6TG8qhTbuVjw3pANXuMjYsZkskasXzR` |
| vault | `CWFPa1gcDqGyeTHTmdbhGjCnQv7eRfdhnBpZKFzNr1R2` | `GoT7214qjHGt6QNqQKhQmqFFVT3qVwzjZvUZK4enV8E7` |
| claim_account (`["user_claim", lending_admin, mint]`) | `dUnUR9XxaVWZo5FUi5DGqsMWfAzYPdtgkuiDbPLLtYX` | `8vVkrDGaQZz2wkVp3ta8WYRMiSQz2WD4ckEpHfmm2oiB` |
| rewards_rate_model | `GGtryeuwjcWoG6zg4Xi1vUJN1xRhypms4xt129BKTUxt` | `CnKAZc6aSnncZRRM9K1bsP1ngS6yAayYYDBQBcQdTwef` |

- **Instructions (Anchor discriminators):** `deposit(u64 assets)` [242,35,198,137,82,225,242,182]; **`withdraw(u64 assets)`** [183,18,70,156,148,109,161,34] = withdraw-by-amount (u64::MAX = all); `redeem(u64 shares)` [184,12,86,149,70,196,97,225]; variants with min-out/max-burn exist.
- **Deposit accounts (17, order):** signer, depositor_token_account, recipient_token_account (fToken), mint, lending_admin, lending, f_token_mint, reserve, supply_position, rate_model, vault, liquidity, liquidity_program, rewards_rate_model, token_program, associated_token_program, system_program. ~67k CU.
- **Withdraw accounts (18, order):** signer, owner_token_account (fToken), recipient_token_account, lending_admin, lending, mint, f_token_mint, reserve, supply_position, rate_model, vault, claim_account, liquidity, liquidity_program, rewards_rate_model, token_program, associated_token_program, system_program. ~73k CU.
- **Share → asset:** `Lending.token_exchange_price` (u64, 1e12 precision) at **account byte 115** (= body offset 107 after the 8-byte discriminator); assets = shares × price / 1e12. It only refreshes on interaction → the program CPIs **`update_rate` first** (5 accounts, ~8–11k CU), then reads it (✅ matches observed share math: 22 USDC → 21,775,173 fTokens at ≈1.0103e12; devnet WSOL price exactly 1e12).
- **Limits:** base withdrawal limit 1M USDC / 1000 SOL, expanding 35% per 6 h — hackathon sizes are far below it. Pool liquidity ~1,765 USDC / ~55 WSOL.
- **Official CPI docs exist** (developers.jup.ag lend/earn/cpi, listing the devnet ids above; IDLs at github.com/jup-ag/jupiter-lend `target/idl`). No official Rust crate. The IDL's `address` is the **mainnet** id; we hand-build the CPI and check the passed program id against `LEND_PROGRAM`, so the IDL address is irrelevant (✅). **IDL mismatch:** deployed devnet Lend requires `liquidity_program` **writable** in deposit (IDL says readonly; else `ConstraintMut` 2000) — passed writable everywhere.
- **PDA depositor — follow marginfi-v2's live pattern** (`programs/marginfi/src/instructions/juplend/{deposit,withdraw}.rs`, `programs/juplend-mocks` for the `declare_program!` interface, `guides/DEVELOPERS_INTEGRATORS/JUPLEND_INTEGRATION.md`): Lend only requires `signer: Signer + mut`, token accounts constrained by `token::authority = signer` (not necessarily ATAs). Rules for us:
  - Use a **data-less authority PDA** per vault (e.g. `["lend_auth", plan]` / `["lend_auth", pool]`), not the Plan/Pool account itself — it must be writable as the signer.
  - That PDA must **own** both the underlying token account and the fToken account; pre-create them.
  - **Call `update_rate` before each deposit/withdraw** (marginfi does).
  - Withdrawals land in a PDA-owned account → a **second transfer** out to the user/maker/pool in the same instruction.
  - ✅ **Verified 2026-10-05** on LiteSVM with the real devnet Lend binaries + accounts: deposit, redeem, withdraw-by-amount from the data-less PDA signer, USDC and WSOL markets. `lend_auth` needs **no lamports** when both token accounts are pre-created. Full round trip loses 1 base unit to rounding (USDC); WSOL exact. Lend rejects tiny ops (`OperateAmountsNearlyZero`, 6028).

**Pyth** — two program sets are live on devnet (pre- and post-26 Aug 2026 upgrade). **Use the upgraded set consistently** (owner checks + feed accounts must match):

| Account | Upgraded (use) | Previous |
|---|---|---|
| Receiver program | `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp` | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |
| Push oracle program | `pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou` | `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` |
| SOL/USD push feed (shard 0) | `7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE` | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |
| BTC/USD push feed (shard 0) | `APgzQGGdv2qCgBkX6aHVkrGePtBVDDg68GiqaM7rmtf5` | `4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo` |
| Wormhole (receiver's) | `HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL` | `HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ` |
| Guardian set (index 1) | `59LY6jV5LcoEdXrhNhX7AJQmW1gHUHQWSLy3299CgGBY` | `8d9szTd157GKCLcxBqiLUgB7mek3v65rbsy2ErRyjwQ5` |
| Receiver config | `H3R4M45f2gyqp6geVUruapzZdyxpgGZ96UnWkDM3ndye` | `DaWUKXCyXsnzcvLUyeJRWou8KTn7XtadgTsdhJ6RHS7b` |

Feed PDA = seeds `[u16 LE shard, feed_id]` under the push program.

**Oracle findings:**
1. **Devnet push feeds:** the **upgraded** set (`rec2…`-owned, SOL + BTC updated together) updates every **~60–70 s** (P2, 15:03–15:19 UTC: gaps 61–70 s, max age ≈ 70 s). ~~Every ~5 min~~ was the previous `rec5…` set (gaps 72–320 s). → devnet `Asset.max_spot_age_secs` = ~~**180**~~ **300** since 2026-10-06 (mainnet 30); observed gaps 320 s (6 Oct 04:45) and 227 s (08:06). Spot reads can be up to ~3 min old on devnet, so the spot-move guard is weaker there — say so in the README.
2. ~~Hermes now requires an API key on both `hermes` and `hermes-beta`, and the devnet receiver uses a 5-guardian test set — mainnet Hermes VAAs probably won't verify on devnet.~~ **✅ Resolved 2026-10-05 (P2, `notes/oracle.md`): Plan A confirmed with mainnet `hermes.pyth.network`.** Hermes VAAs are signed by guardian set **1** (3 sigs, emitter chain 26 Pythnet); devnet Wormhole `HDw2…` holds set 1 at `59LY6j…` (5 keys, no expiry), receiver config `H3R4M4…` wants 3 sigs → mainnet updates verify **Full** through `rec2…`, latest and historical (−15 min, −7 d). `hermes-beta`: our key is not entitled (403) — not needed. ~~Plan B (push-feed-only sampling)~~ **dropped**.
   - Posting = **2 txs**: tx A = create + init + write encoded VAA (292 B VAA, ~3k CU); tx B = verify + post_update + `post_sample` + close encoded VAA + close PriceUpdateV2 (889 B without `post_sample` → 343 B headroom; ~101k CU + `post_sample`). One tx is too big (1,311 B > 1,232). PriceUpdateV2 = 134 B, rent 1,330,960 lamports, reclaimed on close; cost per sample ≈ fees only.
   - Neither Wormhole nor the receiver checks VAA age → staleness/window checks are entirely ours (§3.3 #9).
   - **Hermes rate limit:** 8 parallel requests → 429 (`retry-after: 52`); sequential 1 req/s is fine (p50 254 ms). Keeper serialises Hermes calls ≤ 1/s and honours `Retry-After`.
   - LiteSVM: the full VAA flow runs in LiteSVM (receiver + wormhole `.so`, guardian set, config, `withSigverify(false)`) and is clock-independent; fixtures in `tests/fixtures/pyth/` (gitignored). Most tests just `setAccount` a PriceUpdateV2 (owner `rec2…`) and patch `publish_time`.

## 4. Worker (`worker/`, one Node TS process)

Runs locally first; hosted on the user's **ECS VM** (8 GB RAM; region **Malaysia** (✅ checked 2026-10-05 from the VM: Deribit, OKX, Bybit, Binance options APIs, Hermes, devnet RPC, Z.ai, Cloudflare API all reachable); `pm2`/systemd auto-restart; Caddy for HTTPS; secrets in a chmod-600 env file); external uptime ping on `/health`. Same code on the demo laptop as hot fallback. Plain Node + `@solana/web3.js` 1.x + Anchor TS client via `BideClient` / IDL from `@bide/shared` (`worker/src/chain/anchor.ts`; `pool_take_round` / `flip_plan` builders local to the worker until shared has them). All DB access through `worker/src/db/` (Supabase if keys set, else an in-process store with the same interface). Keypairs from env: JSON array, base58, or a `keys/*.json` path (local dev); never logged. Tests: ~~112 pass (71 W + 41 desk), 2026-10-05~~ **189/189** (2026-10-06 11:30 UTC, incl. desk and agents). **Deployed:** ECS VM, pm2 as user `bide`, code in `/opt/bide`, Supabase store, bound to `127.0.0.1:8787`; no public route yet (80/443 taken on the VM; Caddy unused) — `worker/DEPLOY.md`.

### 4.0 Jupiter reference data (every 60 s, cached)
- `GET https://api.jup.ag/lend/v1/earn/tokens` → mainnet Lend APY (USDC, WSOL) for the "vs Jupiter" panel + desk tool. `GET https://api.jup.ag/price/v3?ids=<SOL mint>` → spot reference for UI/desk (never for settlement — Pyth only).
- Keyless = 0.5 RPS (429 after ~5 quick calls) → call only from the worker, 60 s cache in memory + Supabase `reference_data`, serialised limiter (2 s gap keyless, 1 s with key, 10 s penalty on 429); optional free Jupiter Portal key (`JUP_API_KEY`, `x-api-key`) = 1 RPS.
- ✅ `supplyRate` / `rewardsRate` / `totalRate` are **bps** (USDC 380 + 36 = 416 = 4.16%, 2026-10-05).
- **No Jupiter REST API has a devnet mode** (devnet params are ignored) — never use them for devnet balances or positions.

### 4.1 Pricer (every 10 s)
1. Fetch the four venues (endpoints in SPEC §6). Normalise: IV as decimal (Deribit `mark_iv`/100), parse strike/expiry from instrument names, drop `0` IVs. **Deribit bid/ask IV** is implied from `bid_price` / `ask_price` (Black-76 on `underlying_price`) — the book summary has no bid/ask IV and ~700 `public/ticker` calls per refresh isn't viable. **Binance forward** = `/eapi/v1/index` spot (r = 0); its no-quote markers (bidIV ≈ 6e-7, askIV = −1) = missing.
2. Filter: older than 30 s, no bid, bid/ask spread > 10 vol points. ⚠️ Live 2026-10-05: short-dated (1-day) quotes often fail this (spot−5% 1-day: 0 venues; spot−2%: Deribit + Bybit only) → 1-day std rounds often unpriced; the desk then picks a longer expiry. Kept as-is — **open choice for the user** (option: 20 vol points for T < 2 d; SPEC §6 rule change).
3. Per venue, per expiry: sort by log-moneyness `k = ln(K/F)` using that venue's forward/underlying. Linear interpolation of IV in k. No extrapolation outside listed strikes.
4. Across expiries: linear in total variance `w = σ²T`. Below the shortest listed expiry: **quick plans only** → flat IV of the nearest expiry, flagged `quick_pricing = true` and labelled in the UI.
5. Consensus: fair IV = median of venue mid-IVs; bid IV = median of venue bid-IVs; need ≥ 2 venues.
6. Black-Scholes (r = 0) with Pyth spot → per-unit put (or call) price → × size → USDC.
7. Output `{fairPremium, bidPremium, start = fair × 1.3, floor = bid × 0.9, venues[], quick_pricing, fillProbability}`. Clamp order (as built): start = ⌈1.3·fair⌉, floor = ⌈0.9·bid⌉ (rounded up, user's favour) → floor ≤ fair → if start > 3·floor, start = 3·floor → only if that drops start below fair: floor = ⌈fair/3⌉ (flag `floorRaised`). The program also requires `premium_floor > 0`. Cache in memory + `quotes` table. Real venue snapshots for tests: `worker/test/fixtures/`.

### 4.2 Makers (2 keypairs, optional 3rd; one module, every 2 s)
- Poll Round accounts with status Auction (`getProgramAccounts` + memcmp on status).
- Maker i bid = fair × (1 − s_i), with **s_i re-drawn uniformly from [0.02, 0.14] every round** and a per-bot vol tilt of **±2%** (±5% let maker-2 win ~98% of simulated rounds; test asserts each bot wins > 10% of 500); per-bot inventory cap (skip if escrow balance too low). Skip if bid < floor. Winner varies round to round.
- **AI maker agents (2026-10-06, notes/agents.md):** with `MAKER_LLM` on, each bot's bid comes from a per-epoch GLM stance `{bid|pass, spread_pct 0–20, thesis, confidence}` → `bid = fair × (1 − spread)`, clamped to `[floor, min(start, fair)]`; no LLM bid when fair < floor; stance pending > 15 s or failed → the deterministic bid above, labelled `fallback`. Quick epochs use a reference grid at the nearest OTM tick + one (std: ~2% / 5% OTM). Bots are tried highest bid first. Every bid → `maker_bids` (hash, thesis, took, tx). Before a take the bot holds (no tx) while the push feed is older than `max_spot_age_secs − 15 s`; a landed `StalePrice` / `PriceConfidenceTooWide` is retried, not abandoned.
- When `auction_price(now) ≤ bid_i` → send `take_round` (spot is read on-chain from the Pyth push feed; no VAA to post). Hold WSOL (put escrow; top up to `MAKER_WSOL_TARGET` = 1 SOL at startup, keeping 0.5 SOL native) and USDC (call escrow).

### 4.3 Keeper (every 3 s)
1. On schedule: `open_epoch` ahead of time — Std: next 2 dailies, next 4 Fridays, last-Friday monthly; Quick (if enabled): next 3. Epoch constants read from `@bide/shared`.
2. Auctions past the pool window with no taker → `pool_take_round` (if caps allow) else `cancel_round`. **As built (2026-10-06):** `take_round` is only legal until pool_open, so the keeper tries `pool_take_round` only inside `[pool_open, pool_open + 57 s]` (program deadline pool_open + 60), holds (no tx) while the push feed is older than limit − 15 s, and cancels after the deadline or a non-retryable pool failure.
3. Epochs **with Live rounds** in their sampling window (empty epochs just go Failed): for each bucket whose start has passed and isn't filled → at `bucket_start + ~2 s` (Hermes 404s "too recent") fetch `GET /v2/updates/price/{bucket_start}` → tx A (write encoded VAA), tx B = [verify, post_update, `post_sample`, close encoded VAA, close PriceUpdateV2] (✅ fits, rent reclaimed in the same tx). Hermes ≤ 1 req/s, honour 429 `Retry-After`. Use `worker/src/pyth/post.ts`, not the JS SDK. One set per epoch, not per round. Spot for auctions comes from the Pyth push feed, so the keeper posts VAAs only for samples.
4. Past expiry with all n samples (or past `expiry + grace_secs`) → `resolve_epoch`, then `resolve_round` for each of its rounds; if exercised → `withdraw_collateral` (retry with backoff). Past `expiry + grace_secs` without enough samples → `resolve_epoch` marks it Failed → `unwind_round` for each Live round.
5. Wheel plans with `size_filled == size_total` in Accumulate → `flip_plan` (if the desk says flip).
6. Plans past `horizon_end` with no live round → `expire_plan` (funds back to the user).
7. Active, unpaused plans with no active round, inside an auction window for their epoch kind → run the **desk** → submit its proposal **as-is** via `open_round` (**`skipPreflight`**, so a rejection is a real failed tx with an explorer link; `desk_runs.tx_sig` set on rejections too). If the program rejects it, log the error code to the desk run and ask the desk once more with the error as context (`retryWithChainError`).
   - Quick plans: the desk starts **90 s before** the auction window (`QUICK_DESK_LEAD_SECS`; GLM-5.3 always thinks, up to 8 tool rounds), result held until `expiry − 600`. Finished after the window (quick `expiry − 540`, std 08:30 UTC) → off-chain `WindowMissed`, **not submitted**, no retry.
   - `open_round` is retried up to 3× on transient (non-program) failures while the window is open. **Chained quick rounds:** a quick plan whose Live round expires at the next window's opening second runs its desk in the lead; the keeper holds `open_round` until `resolve_round` frees the plan. The desk is offered only the epoch(s) `open_round` can still target. Zombie `running` desk runs are marked `abandoned` at startup.
   - Off-chain failures (`EpochNotFound` — proposal expiry with no Epoch account, `WindowMissed`, `Transient`) get `desk_runs.status` `offchain_error` / `submit_failed`; only `status = 'rejected'` counts as a real on-chain rejection in the UI.
8. Mirror: Round accounts close on Cancelled / not-exercised / Settled / Unwound, so a vanished round's final status is inferred from its last state (Auction → Cancelled; Live → Resolved, or Unwound if the epoch Failed; Resolved → Settled). Run only **one** keeper (VM or laptop).

### 4.4 HTTP (Hono)
- `POST /desk/preview` (shared secret; fails closed when unset; constant-time compare) → 202 + `desk_run_id` (or the result with `?wait=1`); runs pricer + desk for a draft plan (registered in memory as `draft:<uuid>` so `get_plan` works), writes progress to `desk_runs`.
- `POST /intake {text}` → 202 `{intake_id}`, `GET /intake/:id` (shared secret, ≤ 600 chars).
- Public-route hardening (2026-10-06): strict zod bodies (unknown keys rejected, bounded values), sliding-window per-IP + global limits, preview cache; previews + intake run in the LLM queue's low lane (1 in flight, bounded backlog → 429). The app's `/api/*` routes repeat the checks early (`app/app/api/_lib/guard.ts`).
- `GET /quotes/:asset?kind&strike&expiry&size&quick`.
- `GET /health` — env as SET/EMPTY only, repo backend, chain status, per-loop stats; 503 if any loop has ≥ 5 consecutive errors.
- Startup: `chain-init` retries every 60 s; mirror, keeper and makers start once the program **and Config** exist.

### 4.5 Notify (Telegram) — REMOVED 2026-10-06
Removed by user decision (SPEC decision log). The mirror still derives these plan events and logs them; nothing is sent.
- Bot `/start <plan_pubkey>` deep link (button on `/plan/[id]`) → store `(wallet = plan owner, plan_pubkey, chat_id)` in Supabase `telegram_links` (no anon SELECT).
- On `RoundTaken`, `RoundResolved`, `PlanFlipped`, `PlanExpired` for a linked plan → bot message to its chat. Events come from **mirror state diffs**, not event logs (Auction→Live = RoundTaken; Live→Resolved or a vanished Live round on a Resolved epoch = RoundResolved; phase flip; Closed after horizon).

---

## 5. Agent desk (Z.ai GLM)

**Roles — dual model: a generative model proposes, a decision model judges, the program enforces.**
- **Quant — GLM 5.3** (generative, tool calling). Proposes `{action: open|skip|flip|stop, strike, size, epoch (expiry), auction_secs, premium_start, premium_floor, rationale}` from tool outputs. Real choices: **expiry** by distance to target (target within 3% of spot → 1–2 days; 3–8% → ~1 week; > 8% → 2–4 weeks; never past the user's deadline — `price_grid` shows the premium for each so the choice is evidence-based), **size** for this round (ladder toward the goal, e.g. 1/3 per round), strike only if unlocked, **skip** before events / on thin venues / when premium barely clears the user minimum, **flip** to the exit side after a fill. The prompt does **not** forbid out-of-bounds values; it is told the chain will reject them.
- **Risk — Cloudflare Clef** (`@cf/cloudflare/clef`, decision model, released 1 Oct 2026). Gets a `state` JSON (proposal + tool outputs + user's stated patience — **not the plan bounds**; bounds are the chain's job, so out-of-bounds proposals reach `open_round` and get rejected on-chain) and typed questions; returns **probabilities**, not text. Binding: if `P(veto)` is highest → no `open_round` this cycle; if `adjust` → Quant gets one retry with the top-scoring concern.
  - Questions (1–64 per request allowed):
    - `verdict` — `choice`: `approve` / `adjust` / `veto`, each with a criteria description
    - `event_risk` — `score`: none / low / medium / high (from the static event calendar in state)
    - `data_quality` — `score`: venue dispersion + quote freshness
    - `user_fit` — `choice`: matches the user's stated patience / too aggressive / too passive
    - `explanation_ok` — `noul`: is Quant's rationale consistent with the numbers in state?
  - UI shows the probabilities ("Risk: 86% approve, event risk low") next to the memo hash.
- ~~**No Intake model.** The beginner form collects every field. Free-text input is **cut** (decision 2026-10-05).~~ Superseded 2026-10-06 (AI v2): GLM **intake** drafts the form from free text; the user reviews and signs; every field re-validated in code.
- **Card renderer** — deterministic code.
- **Fallback:** if Clef is unavailable, Risk runs on GLM 5.3 with a strict JSON schema (same questions, same verdict rules). **Build the GLM fallback first, Clef second** — Clef launched 1 Oct 2026 and is unproven.
- **Not using Jev** (TypeSafe AI): limited early access since 15 Sep 2026; can't count on access in time.

**Summary: 2 AI models, 2 AI roles.** GLM 5.3 = Quant (proposes). Clef = Risk (judges). The Solana program enforces the user's bounds; it's code, not AI.

**Where Clef runs — `RiskJudge` adapter with three backends (env `RISK_BACKEND`):**
| Backend | When | Notes |
|---|---|---|
| `workers-ai` (**default**) | hosted demo + live URL | REST call to `@cf/cloudflare/clef` or `clef-flash`; nothing to host; always reachable by the deployed worker |
| `local` | dev, offline, cost-free experiments | **Clef-flash (9B) only** — Clef 27B needs ~54 GB, this Mac (M5, 24 GB) can't fit it. Must use Cloudflare's **official** path (`joint_schema_model.py` with transformers, or vLLM/SGLang): Clef scores options with a dedicated **joint schema head**, so community GGUF/Ollama builds that run it as a chat model **won't give the typed probabilities**. bf16 9B ≈ 18 GB → tight on 24 GB; expect to need a quantised load. Exposed as a small local HTTP service the worker calls. |
| `glm` | Clef down | strict-JSON GLM fallback |

**Why default to hosted:** the live URL must work when the laptop is closed, and the ECS VM has no GPU. Local is a nice-to-have, and the startup path later is self-hosting Clef on a GPU for cost and privacy (Apache 2.0 allows it).

**Calls:**
- Z.ai (OpenAI Chat Completions compatible, ✅ docs 2026-10-05): `POST {base}/chat/completions`, Bearer; OpenAI-style `tools` (`arguments` = JSON string); `tool_choice` **`auto` only**; `response_format` **`json_object` only** → strictness = zod + one repair turn; GLM-5.3 **always thinks** (latency). Base URL `https://api.z.ai/api/coding/paas/v4` if the key is on a GLM Coding Plan, else `https://api.z.ai/api/paas/v4` — ✅ ours is a Coding Plan key (live since 2026-10-06 05:13 UTC). **All GLM calls go through one queue** (`worker/src/agents/queue.ts`): keeper desk 0 → maker stances 1 → previews/intake 2 (low lane).
- Clef via REST: `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef` with Bearer token (works from Node; no Worker needed). Body **requires `model`** (`clef` | `clef-flash`) even though it's in the URL; `questions` = object keyed by id, `type` ∈ {choice, score, noul}. Pricing $0.24 / M input (flash $0.09), 65,536-token context; Workers AI free tier 10k neurons/day (✅ docs). Response envelope/answer shapes from a secondary source → parser accepts the variants, fails loudly (`RISK_OUTPUT_INVALID`); tighten after the first real call.

**Tools (all deterministic, from the worker):**
| Tool | Returns |
|---|---|
| `get_plan(plan_id)` | plan state, bounds, user minimum premium, `fee_bps`, `strike_tick`, and **all** open epochs for the asset (not filtered by plan bounds) |
| `get_spot(asset)` | Pyth spot + conf |
| `price_grid(asset, kind, strikes[], expiries[], size)` | per cell, totals for `size` as u64 strings in USDC base units: fair/bid/start/floor + venue breakdown; a pricer failure → cell `error`. Toolbox adds derived fields (days to expiry, notional, `user_min_floor` after fee, ladder sizes, distance band) so the LLM does no arithmetic; nothing filtered or clamped |
| `fill_probability(asset, strike, expiry)` | N(d2)-style probability from consensus IV |
| `lend_apy(mint)` | bps or null. devnet: from the on-chain exchange rate (**not built yet** — `devnet_apy_bps` null); reference: mainnet APY from Jupiter `GET https://api.jup.ag/lend/v1/earn/tokens` (supplyRate + rewardsRate, ✅ bps), labelled "mainnet reference" |
| `venue_dispersion(asset, expiry)` | spread of venue IVs (data-quality signal) |
| `spot_moves(asset)` | 1h / 24h / 7d realised moves |
| `event_calendar()` | **static curated JSON** (FOMC dates etc., filled at kickoff from official sources) — never model memory |

**Memo:** `{inputs, quant_proposal[], clef_answers (probabilities), final, tool_traces, model_ids, timestamps, provenance}` → canonical JSON (keys sorted, floats 6 dp; re-hash of the stored jsonb gives the same sha256) → sha256 → `memo_hash` in `open_round`. `provenance` = whether each proposal number appears verbatim in a tool output (informational). Full memo in Supabase `desk_runs`.

**Built rules (A lane, 2026-10-05; code `worker/src/desk/`, contract in `notes/desk.md`):** `runDesk()` → `final.status` ∈ open / skip / flip / stop / vetoed / error; keeper submits `open` as-is, one `retryWithChainError` on rejection. Quant ≤ 8 tool rounds then one tool-less turn. Risk runs only on `open`; verdict = argmax (ties → more conservative); `adjust` → one Quant retry, Risk judges again (veto stops; no second retry). Risk backends `RISK_BACKEND` then `glm`; **all down → fail closed** (no `open_round`). Risk state is whitelist-built (bounds, horizon, remaining size, rate limits, `user_min_floor` excluded — tested). ~~Known gap: Quant's free-text rationale reaches Risk unscrubbed.~~ Fixed 2026-10-06: `scrubRationale` removes plan-bound values from the rationale before Risk reads it. Card is deterministic, shows the after-fee pay **range** (floor→start); a test bans option jargon in it. Event calendar `worker/src/desk/data/events.json` (FOMC Oct 28, Dec 9, Jan 27 2027 tentative; CPI Oct 14, Nov 10, Dec 10; jobs Nov 6, Dec 4).

**Hero demo (real, not cued):** run the worker continuously from ~H20; every rejection (`StrikeOutOfBounds`, `PremiumBelowUserMin`, `ExpiryOutOfBounds`, `SizeTooLarge`…) lands in `/desk` with its tx link and the accepted retry. The recording uses one of those real rejections. Pitch line: "the agent is allowed to try; the program decides." If asked "did you prompt it to break the bound?" → "No — the prompt doesn't forbid it and Risk doesn't see the bounds; here are N rejections from the last X hours." Don't tune the prompt to provoke them.

---

## 6. Frontend (`app/`)

| Route | Content |
|---|---|
| `/` | Landing: one-liner, how it works in 3 steps, "vs Jupiter" table |
| `/earn` | Beginner form: **Buy cheaper / Sell higher / Both** → asset → target slider + Patient/Balanced/Eager (Both: also an **exit-price** input) → amount → **by when (1 wk / 1 mo / 3 mo / date)** → **quick-plan toggle** (labelled, opt-in) → minimum yield (preset) → **Preview** (desk runs live, steps stream in) → two-scenario confirmation (filled / not filled, plus crash case) + **payoff slider** → **Start earning** (one signature: `create_plan`; Sell wraps SOL in the same tx) |
| `/plan/[id]` | Status timeline (Auction → Live → Sampling → Resolved), premium earned, Lend yield, countdown, samples as they land, "Why this?" drawer (memo + tool traces + memo hash + explorer links), pause/close buttons |
| `/desk` | Live feed of desk runs incl. rejected proposals; header counter "N real on-chain rejections in the last X h" (count only `desk_runs.status = 'rejected'`); skip / ladder / expiry decisions shown with their reason |
| `/auctions` | Public tape: per round start, floor, CEX reference, winning bid, winner (bot / outside wallet / pool), fee — from the `rounds` mirror |
| `/maker` | Live auctions with falling price + "Take" (any wallet) |
| `/api/actions/plan` + `/actions.json` | Blink (Solana Action) for a prefilled plan |
| `/pool` | Minimal: deposit / withdraw + plain risk note (NAV math lives in the program; no UI polish) |

**Style (2026-10-06):** dark-first terminal look — Inter + JetBrains Mono, blue-grey neutrals, one mint accent, swap-card inputs, compact tables. jup.ag is the style reference only; no Jupiter logo, name, colours or copy in the chrome (`app/brand.md`, `app/design-reference.md`). `/earn` also has "Describe your goal" (intake); `/auctions` shows each round's maker bids/theses and the per-maker P&L ledger. `/pool` deposit button not wired yet (no deposit builder in `app/lib/bide-client.ts`).

Data: Supabase realtime on `desk_runs`, `rounds`; on-chain reads for balances. Wallet adapter (Phantom, Solflare) on devnet. No secrets client-side; `/api/*` routes call the worker with the shared secret.

---

## 7. Supabase schema

- `quotes(asset, ts, fair_iv, bid_iv, venues jsonb, quick_pricing bool, kind, strike, expiry, spot, premiums)`
- `desk_runs(id, plan_pubkey, kind preview|round, steps jsonb, proposal jsonb, verdict jsonb, final jsonb, memo jsonb, memo_hash text, tx_sig text, error_code text, status, card jsonb, created_at, updated_at)` — `status = 'rejected'` only for real on-chain rejections; `offchain_error` / `submit_failed` for the rest
- `rounds(round_pubkey, plan_pubkey, strike, size, expiry, premium_paid, maker, is_pool, status, settle_price, exercised, sigs jsonb, notional, kind, premium_start, premium_floor, fee_paid, memo_hash)` (mirror written by the keeper)
- `plans(plan_pubkey, owner, asset, side, phase, quick, target_strike, exit_strike, size_total, size_filled, horizon_end, status, updated_at)` (mirror)
- `epochs(epoch_pubkey, asset, kind, expiry, samples jsonb, settle_price, status)` (mirror)
- `telegram_links(wallet, plan_pubkey, chat_id)` — legacy, unused since 2026-10-06 (Telegram removed); kept in the init migration, **no anon SELECT**
- `reference_data` (Jupiter cache)
- RLS: anon can `select` only (except `telegram_links`); writes only with the service key (worker). Realtime on `desk_runs`, `rounds`, `plans`, `epochs`.
- AI v2 (`20261006090000_agents.sql`): `maker_stances`, `maker_bids` (anon select), `intake_runs` (no anon select); `rounds.asset / auction_secs / pool_delay_secs`. `waitlist` (`20261005160000_waitlist.sql`, anon insert only).
- Migrations: `20261005150000_init.sql`, `20261005160000_waitlist.sql`, `20261006090000_agents.sql` — ✅ all applied on the live project; the worker probes the required tables at startup and falls back to memory if any is missing.

---

## 8. Phases and timeline (36h; H0 = kickoff)

Lanes can run in parallel (P = program, W = worker, A = agents, F = frontend). **P lane publishes a stub IDL (accounts + instruction signatures) by H3** so W / A / F can build against it before the program is done.

### Phase 0 — Setup and verification (H0–H2)
- [x] (2026-10-05: git init, pnpm workspace, anchor scaffold, `.env.example` done; program id `4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe`, keypair backed up to `keys/bide-program.json`) `git init`, pnpm workspace, `anchor init`, Next app, worker skeleton, `.env.example`; `git init` only — **no commits/pushes until the user allows it**; then check `git status` shows no `keys/` or `.env*` first.
- [ ] **VERIFY** (status 2026-10-05 ~15:45 UTC):
  - [x] All external APIs incl. Binance reachable from the ECS VM; the four CEX endpoints live from the build machine (pricer run against all 4).
  - [x] Jupiter Lend withdraw-by-amount + share rounding (burn rounds up → `LEND_DUST_BUFFER` 10) + exchange-rate read (`token_exchange_price` @ byte 115 after `update_rate`) — §3.7.
  - [x] Pyth devnet receiver (`rec2…`, pro-compatible SDK) + Hermes historical endpoint (`publish_time` exactly `t`, 1 Hz) — mainnet Hermes verifies Full; Plan A — §3.7.
  - [x] Jupiter `/earn/tokens` rate units = bps.
  - [x] Z.ai (✅ 2026-10-06: Coding Plan key, coding base URL, live desk runs 50–100 s): from docs — OpenAI-style tools, `tool_choice` auto only, `response_format` json_object only, `glm-5.3` listed, thinking always on. **Open:** whether our key is Coding Plan (base URL), `reasoning_content` echo in multi-turn, real latency — needs the key (`worker/src/desk/verify-live.ts`).
  - [x] Clef (✅ live via Workers AI since 2026-10-06 05:13; binding approve/veto observed): REST shape from Cloudflare docs (body needs `model`; `questions` keyed by id); free tier 10k neurons/day. **Open:** response envelope/answer shapes (secondary source; parser accepts variants) — one real call settles it.
  - [ ] (optional) Clef-flash local via the official transformers script on the M5.
- [ ] **VERIFY (more):**
  - [x] ~~Lend Liquidity program in the `[test.validator] clone` list~~ — tests run on LiteSVM with dumped devnet binaries + accounts (`scripts/dump-fixtures.sh` → `tests/fixtures/`), incl. Liquidity.
  - [x] Wormhole `HDw2…` + guardian set 1 + receiver config dumped; full VAA flow runs in LiteSVM (`withSigverify(false)`, clock-independent).
  - [x] Lend accepts a **PDA depositor** (data-less `lend_auth`, no lamports needed) — deposit, redeem, withdraw-by-amount, USDC + WSOL. Withdrawal limits far above hackathon sizes.
  - [x] Pyth push-feed addresses (SOL/USD, BTC/USD shard 0) match §3.7; owner `rec2…`; cadence ~60–70 s → devnet `max_spot_age_secs` 180.
  - [ ] Circle faucet amount per request + rate limit.
  - [x] Program size 761,832 B → programdata rent 3.87 SOL; recommend `--max-len 1100000` (5.59 SOL) for upgrade headroom → ~9.5 SOL transient during deploy (buffer refunded). Deployer has 12.5 SOL.
  - [x] Back up the program keypair into `keys/` (`keys/bide-program.json`).
  - [x] From the **ECS VM**: every external API reachable.
- [x] **Name lane owners** (P / W / A / F) — SPEC §17. ✅ 2026-10-05: all lanes = Opus 5.5 agents run by the orchestrator; Fable 5.1 advisor (SPEC §18).
- [x] Fund: maker-1/2 SOL, Circle USDC for makers + demo wallet + deployer (pool deposit); wrap WSOL for makers and pool. (Balances: WALLETS.md, 2026-10-06.)
- **Exit:** every VERIFY answered and written into this file.

### Phase 1 — Program core on real integrations (P lane, H2–H12)
- [x] **First:** Jupiter Lend deposit/withdraw CPI against real devnet Lend (LiteSVM) ✅ 15:25 UTC; Pyth `PriceUpdateV2` checks (P2 posted real Hermes updates on devnet; program tests use dumped Full PriceUpdateV2 bytes with `publish_time` shifted into buckets). ALT not built yet.
- [x] State, errors, events, math (u128, auction price, median, decimals). IDL + `@bide/shared` client published 15:10 UTC (re-sync: `anchor build && node scripts/sync-idl.mjs`).
- [x] All instructions on the real integrations — ✅ all 28 implemented and deployed (2026-10-05, Fable fixes at slot 507875135). ~~**implemented:** admin, `create_plan` (Buy/Sell/Wheel), `pause/close/expire_plan`, `open_epoch`, `open/take/cancel_round`, `post_sample`, `resolve_epoch/round`, `withdraw_collateral`, `unwind_round`. **Layout frozen, `NotImplemented`:** `update_plan`, `flip_plan`, `pool_take_round`, `init_pool`, `pool_deposit`, `pool_withdraw`, `pool_lend_idle`, `pool_unlend`.~~
- [x] Tests (`tests/src/`, LiteSVM): ✅ 28/28 — put + call loops, wheel, pool, update_plan, negatives, real-VAA samples, review fixes. ~~put loop exercised + not exercised ✅. Still to do: call exercised + not exercised; wheel flip; negatives for every bound (strike, tick, expiry, min premium, floor/start clamp, spot guard, stale/wide/wrong-feed sample, duplicate bucket, early resolve, rate limit, paused, **unwind only on a Failed epoch** (rejected on a resolvable one), unwind releases pool exposure, withdraw with 1-unit Lend shortfall, **pending-settlement blocks close/open/update/expire/flip**, **epoch-kind mismatch**).~~
- **Exit:** ✅ 2026-10-05 ~15:45 UTC — full put loop passes on LiteSVM against the real devnet Lend + Pyth receiver binaries (`tests/src/putloop.test.ts`).

### Phase 2 — Devnet deploy (P lane, H12–H16)
- [x] (2026-10-05: deployed 15:16 UTC; **upgraded to the full 28-instruction build ~15:35 UTC**, tx `46fp3CmDcvQerm2Ch9A1NmxUMHhL1Ns8HwTEeUgmnKXsGJH2FzitSuXhv8nHis14vkrzYrQQVnM2mxCi6jxGkgC3`; max-len 1,000,000, rent 5.08 SOL; Config + SOL asset initialised (tick 100_000, spot age 180 s); ALT `CEqxacEbFQ2oCJNWtPqQwYBWiyrwsiTakMN786efPoaT`; real Lend CPI smoke-tested on devnet. ~~Pool not initialised yet — deployer USDC short~~ pool initialised 2026-10-06 09:57 UTC: `3vY4n9Wm…`, 25 USDC + 0.5 WSOL, `scripts/init-pool.ts`) Deploy to devnet with `deployer`; run `scripts/init-config`, `add-assets` (SOL), `init_pool` + `first-pool-deposit`.
- [~] Call-round path (WSOL into Lend) ✅ on devnet (not exercised + exercised); `flip_plan` on devnet ⬜ (LiteSVM only).
- **Exit:** a plan on devnet holds real jlUSDC; a round resolves on real Pyth samples.

### Phase 3 — Worker (W lane, H4–H16)
- [x] Pricer (4 venues, filters, interpolation, consensus, BS, quick-plan pricing) + unit tests against saved venue snapshots (2026-10-05; live numbers in `notes/worker.md`).
- [x] Makers (2) and keeper loops: ✅ running on devnet since 2026-10-05 (open_epoch, open_round, take_round, post_sample, resolve, withdraw, unwind, expire, cancel all landed). `pool_take_round` and `flip_plan` not yet landed.
- [x] Supabase tables + writes: all 3 migrations applied; VM worker on `repo: supabase` since 2026-10-06 ~06:11 UTC (earlier laptop runs used the in-memory store, so their history is not in the DB).
- **Exit:** on devnet, with a manually opened round, makers bid, one takes, keeper samples/resolves/withdraws without help.

### Phase 4 — Agent desk (A lane, H8–H20)
- [x] Z.ai client with tool calling; tools wired to pricer/RPC (live since 2026-10-06 05:13 UTC).
- [x] Quant prompt (GLM) + Risk question schema (Clef); zod validation + one repair turn; memo + hash; GLM fallback for Risk (live; Clef approve/veto observed).
- [x] Keeper integration: desk → `open_round` as-is → on rejection, retry once with the error. First desk-opened round 2026-10-06 06:00 UTC (`29YB1b3S…`, exercised).
- **Exit:** the running system has produced at least one real on-chain rejection + accepted retry on devnet, visible in `/desk`. **Status 2026-10-06:** rejections exist (`AuctionParamsInvalid` ×1; timing `OutsideAuctionWindow` ×2, `StalePrice` ×1 — README §5); no accepted retry recorded; no user-bound rejection yet.

### Phase 5 — Frontend (F lane, H6–H26)
- [x] `/earn` form + preview (streamed desk steps) + two-scenario confirm + `create_plan` signing (built; a browser-wallet create on devnet is not yet recorded in the notes).
- [x] `/plan/[id]` timeline + "Why this?" drawer + explorer links.
- [x] `/` landing with the "vs Jupiter" table.
- [x] `/maker`: live auctions, falling price, "Take" (any wallet; escrow + premium signed by the maker).
- [~] `/pool` (minimal): risk note + pool stats ✅; deposit / withdraw button **not wired** (no `poolDepositIxs` builder in the app).
- **Exit:** a beginner can go from landing to a live plan in under 60 seconds.

### Phase 6 — Integration + first recording (H20–H26)
> ⚠️ **The 7 Oct 08:00 UTC (16:00 SGT/MYT) std auction window is the only one inside the hackathon — hard milestone: real std rounds must open in it.** Map it to an H-number at kickoff; the devnet deploy + keeper must be live before it — pull Phase 2/6 forward if kickoff makes it earlier than H20. (Std rounds can only open in the first 30 min after 08:00 UTC; miss it and no real daily round exists before submission.)
- [x] Start **real daily plans** as soon as devnet works. Std plans `GZyrcLHj…` (buy) and `8kaDR2Sn…` (sell); 6 Oct window: call round `5Ccfmg…` taken by maker-2, settles 7 Oct 08:00 UTC; put round cancelled (stale feed, no pool then).
- [ ] Quick plan for the recording: 10-min epochs, 30 s auction, 10 s pool delay, 10 × 10 s buckets, strike = spot − 0.05–0.15% (SOL tick $0.10; run `update_asset` if the asset was added with $1).
- [ ] Take one auction manually from a second wallet via `/maker` (external-maker test).
- [~] Deploy worker to the ECS VM ✅ (pm2, Supabase; no Caddy — no public route yet) + app to Vercel ⬜; leave the worker running from here on so `/desk` and `/plan` accumulate real history.
- [x] Run the full **buy and sell** loops on devnet; fix what breaks (buy ×4+, sell ×3 incl. exercised both ways; README §5).
- [ ] **Record v1 of the demo by H26.**

### Phase 7 — Full scope, in order (H26–H31, required)
1. Pool path shown in the recording (makers paused → pool fills); LP withdraw tested.
2. Wheel flip (buy → sell on the same plan).
3. **Shareable Blink**: `app/api/actions/plan` (Solana Actions spec, `@solana/actions`): GET returns the card + params (asset, side, target, amount, deadline); POST returns a `create_plan` tx for the visitor's wallet; `actions.json` at the site root. **VERIFY** Blink rendering for devnet txs (dial.to `?cluster=devnet`). POST returns a **v0 tx + ALT** (Lend CPI accounts) — **VERIFY** dial.to handles v0 transactions.
4. BTC (tBTC test mint, market-priced) — **only after both SOL loops are solid; not in the recording.**
5. "Worker offline" fallback banner.
6. CPI-composability test (dummy program opens a plan).
7. ~~Free-text goal input~~ (cut).
8. `update_plan` + edit form on `/plan/[id]`.
9. Payoff slider on the `/earn` confirm screen (code-driven).
10. `/auctions` tape.
11. P&L replay on `/plan/[id]`: dollars earned vs a Trigger limit order over the same window (Pyth history).
12. ~~Telegram notifications~~ (removed 2026-10-06) (worker `notify` module, §4.5: `/start <plan_pubkey>` deep link → `telegram_links`; on `RoundTaken`, `RoundResolved`, plan expiry → bot message to linked chat).

### Throughout the event — impact evidence (non-coding lane, ~1 h total)
- [ ] 15–20 short interviews at TOKEN2049 ("Do you have USDC waiting for a SOL dip? At what price? Would you take ~1%/week to commit to buying there?" — log the price each person names: that's the strike-distribution slide), log answers in a sheet.
- [ ] Waitlist form on the landing page; note the count at submission.
- [ ] Talk to 1–2 market makers; quote them (with permission) in the deck.

### Phase 8 — Submission (H31–H35, hard stop H35)
- [ ] Final recording (≤ 3 min, the whole pitch) embedded in the deck (.ppt/.key, not a link).
- [ ] Deck: problem → evidence (incl. interviews/waitlist from the event) → demo video → how it works (diagram) → why Web3 (program enforces agent bounds, memo hash, unwind) → vs Jupiter/Leaps → startup path.
- [~] README: what it is, architecture, devnet program id, how to run, test count, how to run it yourself, honest limits (devnet, quick-plan pricing label, devnet push-feed spot up to ~~180~~ 300 s old so the spot-move guard is weaker than mainnet's 30 s, our 2 maker bots + first pool deposit, unhedged pool v1, worker on own ECS VM + laptop fallback). ✅ 2026-10-06 except the live URL (placeholder).
- [ ] Live URL (Vercel) + worker running; repo public or judge access.
- [ ] Submit before **11:59pm 7 Oct**.

---

## 9. Quick plan parameters (opt-in, labelled — used for the recording)

| Param | Value |
|---|---|
| Round expiry | next quick epoch (every 10 min) |
| Auction | 30 s, then 10 s pool delay |
| Sampling | 10 buckets × 10 s = last 100 s before expiry |
| Size | 0.2 SOL (notional ≈ $24 at a $120 strike) |
| Strike | for the recording: ~~spot − 0.3–0.5%~~ **spot − 0.05–0.15%** (typed by the user; SOL `strike_tick` $0.10) → premium clears the minimum, fill ≈ 50/50. With a $1 tick this was impossible: for a 10-min epoch σ√T ≈ 0.17%, so $1 ≈ 5σ (live 2026-10-05: K = spot+0.3% → P(fill) 96%; K = spot−0.5% → fair ≈ $0, `PremiumBelowUserMin`) |
| Min premium | 0.10%/day of notional |
| Pricing | quick-plan pricing (flat nearest-expiry IV), labelled; show the real cents premium **plus** "1-day equivalent ~$X". **No annualised APY.** |

Don't force an outcome: record several takes and use whichever happened (filled and not-filled are both honest). Check before recording that the quick-plan premium actually passes `PremiumBelowUserMin` at the chosen strike.

**Recording note (fee):** in the recording, show the **after-fee figure on `/plan`**, not the raw wallet balance, because demo-user also receives the fee (`fee_recipient` = demo-user on devnet).

---

## 10. Definition of done

- [ ] A beginner creates a SOL buy plan on devnet in one signature; USDC lands in Jupiter Lend. (Script-created plans prove the Lend deposit; a browser-wallet create is not recorded yet.)
- [ ] The running desk has real on-chain rejections in `/desk`; one is shown on camera with the accepted retry. (Partly: rejections exist, mostly timing; no accepted retry yet.)
- [x] A round whose keeper is stopped is unwound by anyone after the grace period; no funds stuck. (Devnet: `HWVZxk5v…`, run #1.)
- [x] Real daily plans are running on devnet, not just quick plans. (Std call round `5Ccfmg…` settles 7 Oct 08:00 UTC.)
- [ ] Zero mocks in the codebase.
- [x] Two makers compete; one takes; the premium arrives in the user's wallet.
- [x] Real Pyth samples resolve the round; the user receives SOL at exactly the strike; the maker receives USDC; Lend yield returns to the user. (Exercised put `FuHpJLae…` and desk round `29YB1b3S…`; Lend yield ≈ 0 on devnet.)
- [ ] All of it in a ≤ 3 min recording, embedded in the deck, submitted on time.
