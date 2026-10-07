# Worker (W lane): status, findings, decisions

Written 2026-10-05, about 15:20 UTC. The code is in `worker/` (the A lane owns `worker/src/desk/`) and `supabase/migrations/`. Tests: `pnpm --filter @bide/worker test` → **112/112 pass** (71 W + 41 desk). `tsc --noEmit` is clean.

## What works (run, not assumed)
- **Pricer** (BUILD §4.1, SPEC §6), live against all 4 venues and Pyth Hermes:
  - Venue fetchers: Deribit, OKX, Bybit, Binance.
  - Filters: older than 30 s, no bid/ask, spread above 10 vol points.
  - Per-venue smile, linear in log-moneyness, using the OTM side per strike. No extrapolation.
  - Total-variance interpolation across expiries.
  - Quick plans below the shortest expiry use a flat IV of the nearest expiry and get `quick_pricing = true`.
  - Consensus is the median, over at least 2 venues. Black-Scholes with r = 0 on Pyth spot.
  - Anchors are start = fair×1.3 and floor = bid×0.9, clamped to floor ≤ fair ≤ start ≤ 3×floor.
  - Real snapshots are saved in `worker/test/fixtures/` (captured 2026-10-05 14:52 UTC).
- **Jupiter reference** (§4.0): 60 s cache plus a serialised rate limiter (2 s gap without a key, 1 s with `JUP_API_KEY`, 10 s penalty on 429). The cache is mirrored to `reference_data`.
  - **VERIFY answered:** `supplyRate` / `rewardsRate` / `totalRate` are **bps** (USDC: 380 + 36 = 416, i.e. 4.16%).
- **HTTP (Hono)** was booted and probed:
  - `GET /health` reports env as SET/EMPTY only, plus repo backend, chain status and per-loop stats. It returns 503 if any loop has 5 or more consecutive errors.
  - `GET /quotes/:asset?kind&strike&expiry&size&quick`.
  - `POST /desk/preview` checks the shared secret, fails closed when it is EMPTY and uses a constant-time compare. It returns 202 with `desk_run_id`, or the result with `?wait=1`.
  - Preview ran end to end into the A lane desk. It fails closed with `MISSING_SECRET: ZAI_API_KEY`, as expected.
- **DB:** all access goes through `worker/src/db/`. Supabase is used if `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set; otherwise an in-process store with the same interface.
  - Migration: `supabase/migrations/20261005150000_init.sql`.
- **Keeper and makers:** the decision logic is pure functions with unit tests. The executors are wired to the chain.
- **Chain client** (`worker/src/chain/anchor.ts`): built on the P lane's `BideClient` and IDL from `@bide/shared`.
  - `pool_take_round` and `flip_plan` are built locally from the IDL, because the shared client has no builder for them yet.
  - The PDA, schedule-constant and min-premium mirrors are **cross-checked against `@bide/shared` in tests**.
- **Pyth posting:** `scripts/pyth/post.ts` is copied to `worker/src/pyth/post.ts` (Plan A passed). `post_sample` runs in tx B with the close ixs (closeUpdateAccounts).
  - **VERIFY answered:** Hermes `GET /v2/updates/price/{t}` returns an update with **publish_time exactly t**. Checked at t − 60 s, 10 min, 30 min, 1 h and 24 h. The 2 s bucket tolerance is fine.
- **Keypairs:** loaded from env as a JSON array, base58, or (local dev) a `keys/*.json` path. Public keys match WALLETS.md (keeper `CXei…`, maker-1 `FBrE…`, maker-2 `9aa4…`). Values are never logged.

## Live pricer numbers (2026-10-05 15:15 UTC, Pyth SOL/USD 119.60, size 1 SOL)
| Case | Venues used | Fair IV / bid IV | Fair | Bid | Start | Floor | P(fill) |
|---|---|---|---|---|---|---|---|
| Put K=$114 (spot−5%), **Fri 9 Oct 08:00** | Deribit, OKX, Bybit, Binance (all 4 exact) | 50.80% / 49.88% | $0.558 | $0.531 | $0.726 | $0.478 | 18% |
| Put K=$114 (spot−5%), **1-day** (6 Oct 08:00) | **0 → no price** | — | — | — | — | — | — |
| Put K=$117 (spot−2%), 1-day | Deribit, Bybit | 42.29% / 39.14% | $0.125 | $0.095 | $0.163 | $0.085 | 12% |

The 1-day spot−5% case fails honestly. No venue has a usable bid that far out of the money on a 17 h expiry, and the rule forbids extrapolation.

## Findings the orchestrator should act on
1. **⚠️ Quick-plan recording params (BUILD §9) don't work with SOL `strike_tick` = $1.**
   - For a 10-min epoch, σ√T ≈ 0.17%. One $1 tick at $120 is about 0.84%, roughly 5 standard deviations.
   - Live check at the start of a 10-min epoch, 0.2 SOL:
     - K = $120 (+0.31%, ITM): floor $0.067, passes the user minimum, **P(fill) 96%**.
     - K = $119 (−0.53%): fair ≈ $0.00001, floor 0 → **`PremiumBelowUserMin` (rejected), P(fill) 0.1%**.
   - "spot − 0.3–0.5%, ≈50/50 fill" is unreachable.
   - **Fix (config, not code):** `add_asset` / `update_asset` with SOL `strike_tick = 100_000` ($0.10), or $0.05. Then the recording strike is spot − 0.05–0.15%.
   - Also: the program requires `premium_floor > 0`, so any near-zero quote is rejected on-chain.
2. **1-day std rounds will often be unpriceable.** Short-dated IV bid/ask spreads often exceed the 10-vol-point filter.
   - Only Deribit and Bybit passed for 1-day at spot−2%. OKX and Binance dropped all their 6 Oct quotes as wide or no bid.
   - The desk's "within 3% → 1–2 days" band will often get an error cell. The desk handles that by skipping or choosing a longer expiry, so this is not a bug.
   - Option: widen the spread filter for T < 2 d (e.g. 20 vol points). That is a SPEC §6 rule change, so it is the user's decision; I did not change it.
3. **Quick-plan desk latency vs the 60 s auction window.** GLM 5.3 forces thinking and runs up to 8 tool rounds, so a desk run can easily exceed 60 s. What I implemented:
   - Quick-plan desk runs start **90 s before** the window (`QUICK_DESK_LEAD_SECS`). The result is held until `expiry − 600`.
   - If the desk finishes after the window closes (quick: `expiry − 540`; std: 08:30 UTC), the run is recorded as off-chain `WindowMissed` and **not submitted**, with no desk retry. A latency failure must not be counted as "the program rejected the AI".
   - Real latency is still unmeasured, because there is no Z.ai key yet.
4. **The Std pool delay is 60 s** (shared `EPOCH_PARAMS`; BUILD doesn't pin it). The worker now reads all epoch constants from `@bide/shared`.
5. **Maker vol tilt:** ±5% made maker-2 win about 98% of rounds in simulation, because the [0.02, 0.14] spread can't overcome it. Changed to **±2%**; the test asserts each bot wins more than 10% of 500 simulated rounds.

## Decisions / deviations (for the SPEC decision log)
- **Deribit bid/ask IV** is implied from `bid_price` / `ask_price` (Black-76 on the instrument's `underlying_price`). `get_book_summary_by_currency` has no bid/ask IV, and ~700 `public/ticker` calls per refresh is not viable.
- **Binance forward** = `/eapi/v1/index` spot (r = 0). `/eapi/v1/mark` has no underlying or timestamp, and no-quote shows as bidIV ≈ 6e-7 with askIV = −1; those are treated as missing.
- **Anchor clamp order:**
  1. start = ⌈1.3·fair⌉ and floor = ⌈0.9·bid⌉, both rounded up in the user's favour.
  2. floor ≤ fair.
  3. If start > 3·floor, lower start to 3·floor.
  4. Only if that drops start below fair: floor = ⌈fair/3⌉, flagged `floorRaised`.
- **Sampling only for epochs that have Live rounds.** Empty epochs just go to Failed, which affects nothing and saves keeper SOL.
- **Keeper pre-opens Std epochs** for: the next two dailies, the next 4 Fridays and the last-Friday monthly. Quick epochs: the next 3.
- **`open_round` is sent with skipPreflight**, so a program rejection is a real failed transaction with an explorer link. `desk_runs.tx_sig` is set on rejections too.
  - Off-chain codes (`EpochNotFound`, `WindowMissed`, `Transient`) get distinct `desk_runs.status` values (`offchain_error` / `submit_failed`) so the UI can exclude them from the "real on-chain rejections" counter. **F lane: count only `status = 'rejected'`.**
- **Mirror:** Round accounts close on Cancelled / not-exercised / Settled / Unwound. The final status of a round that disappears is inferred from its last state: Auction → Cancelled, Live → Resolved (or Unwound if the epoch Failed), Resolved → Settled.
- **Notify events come from state diffs**, not event logs: Auction→Live = RoundTaken, Live→Resolved or a vanished Live round on a Resolved epoch = RoundResolved, phase flip, Closed after horizon.
- **Telegram:** `/start <plan_pubkey>` stores `wallet = plan owner` (plus a `plan_pubkey` column).
- **Schema additions beyond BUILD §7:**
  - `telegram_links` has **no anon SELECT**, so the wallet↔chat_id mapping stays private.
  - New tables / columns: `reference_data` (Jupiter cache), `desk_runs.card` / `updated_at`, `rounds.notional/kind/premium_start/floor/fee_paid/memo_hash`, `quotes.kind/strike/expiry/spot/premiums`.
  - Realtime publication on `desk_runs`, `rounds`, `plans`, `epochs`.
- **`/desk/preview` drafts** are registered in memory as `draft:<uuid>` so the desk's `get_plan` works before a plan exists. Before the program is live, `open_epochs` = the keeper's scheduled expiries, without pubkeys.
- **`lend_apy.devnet_apy_bps` is null.** It needs a Lend reserve/exchange-rate read; only the mainnet reference is filled.

## Stubbed / waiting
- **The program is not deployed on devnet yet** (`4bwT…` has no account). The worker's `chain-init` loop retries every 60 s and starts mirror, keeper and makers once the program **and Config** exist. No keeper or maker transaction has run on devnet yet, so every write path is **unverified on-chain**:
  - open_epoch, open_round, take_round, pool_take_round, cancel, post_sample, resolve, withdraw, unwind, expire, flip.
  - Account names come from the IDL and `BideClient`, so they should be right, but they have not been executed.
- `pool_take_round` / `flip_plan` program bodies looked like stubs at 15:10 UTC. My builders follow the frozen IDL layout, with remaining accounts for flip = USDC Lend 13 + asset Lend 13, per the `plan.rs` doc comment.
- Supabase keys are missing, so the in-process repo is in use. The migration has not been applied yet.
- `TELEGRAM_BOT_TOKEN` is EMPTY, so notify is off. `ZAI_*` / `CF_*` are missing, so the desk returns `status: error` and no rounds open.
- Makers top up WSOL to `MAKER_WSOL_TARGET` (default 1 SOL, keeping 0.5 SOL native) when chain loops start. This has not run yet.

## Next steps (in order)
1. As soon as the P lane deploys and runs `init_config` + `add_asset(SOL)` (ideally with `strike_tick` = $0.10, see finding 1), start the worker locally with `PROGRAM_ID` and the keypair env vars set to `keys/*.json` paths. Then check, in order:
   - Epochs open.
   - Open one round manually (or let the desk do it once the Z.ai key lands).
   - Makers bid and take.
   - Samples post.
   - Resolve, then withdraw.
2. Apply the migration once the Supabase keys exist (no code change needed).
3. Deploy to the ECS VM per `worker/DEPLOY.md` **before 7 Oct 08:00 UTC**, and run only one keeper (VM or laptop).
