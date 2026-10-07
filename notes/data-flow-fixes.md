# Data-flow fixes (6 Oct 2026, from ~09:55 UTC)

Goal: rounds fill and history accumulates continuously, without touching the live std round
5CcfmgSseQNn8jQUWCDpBx1pJLrtzzj5ZLUCNbRydpcc (samples 7 Oct 07:30–08:00, settles 08:00). No VM restarts 7 Oct 07:20–08:40 UTC.

## Findings before fixing
- Today's std buy round 4vsDuo… (GZyr plan) opened 08:02:12, auction 300 s + pool delay 60 s → pool_open 08:08:12. Both makers had
  fallback bids above floor, but held from 08:06:29 because the push feed was 227 s old (max 180, hold margin 15 s). Keeper cancelled
  at 08:08:13 "no pool".
- **Program rule (programs/bide/src/instructions/round.rs):** `take_round` requires `now <= auction_start + auction_secs + pool_delay_secs`
  (else `AuctionOver`); `pool_take_round` only in `[pool_open, pool_open + 60]`. So makers can NOT take after pool_open: delaying the
  cancel to pool_open + 60 would not have saved the round. Fix 1 is therefore: makers take as soon as the feed is fresh before
  pool_open (they already try), plus the feed limit (fix 2), plus the pool path with the same stale-feed hold (fix 4).
- Quick rounds: LLM stance grid at ±2/5 % → stance "pass" for 10-min epochs (fair ≈ 0); and "fair below the auction floor" when spot
  moved between the desk's pricing and the round open. No pool → every such round cancelled.

## Step 2 — push feed limit
- update_asset SOL max_spot_age_secs 180 → 300 (only that field; others read from chain). `scripts/init-devnet.ts --update` now
  preserves the on-chain fields and only changes max_spot_age_secs.
  tx 2RnLpFaayjTjuaVidxMfEG51U4oJaDrZyrqRtJLWGGBSp8vnZmFPXg8rVvV9XpciexnVE5hZ3Gb5F1dnksrK3JaU (09:56:07 UTC)
  https://explorer.solana.com/tx/2RnLpFaayjTjuaVidxMfEG51U4oJaDrZyrqRtJLWGGBSp8vnZmFPXg8rVvV9XpciexnVE5hZ3Gb5F1dnksrK3JaU?cluster=devnet

## Step 4 — backstop pool (devnet, deployer = authority + first LP)
- `scripts/init-pool.ts` (new; idempotent init, waits for a fresh push feed before depositing, keeps ≥ 2 SOL on the deployer).
  Caps: max_premium_bps_of_notional 150, max_open_notional 40 USDC, max_utilization_bps 5000, spend window 86 400 s / cap 2 USDC.
- Pool PDA 3vY4n9WmQg7PR1W4HJb3zvKRHFevCDgGavdz7FE6u7Q6 — vaults after deposit: 25 USDC, 0.5 WSOL.
  - init_pool https://explorer.solana.com/tx/4RfufuPa1TGAMziNtP8hMpDjZXi9xtzS8TDeL9xnSPof9UuK8cihBgMtMuaB3yE4fskUTHLis9FCpHcYnnk3D35x?cluster=devnet
  - pool_deposit 25 USDC https://explorer.solana.com/tx/39tQQMDJUu8seHVuxXPTef8ABfdXYkkHLAiBR2K3Dhjki6TgeSNXHBFcbaMjAs6e85NkfUdynpo3DCxRLugtwdVf?cluster=devnet
  - wrap + pool_deposit 0.5 WSOL https://explorer.solana.com/tx/457gvEUVuEoYs3HCJFUPSXJr87fPtex1h92DtcE8VDrxUAYNEdBvnaFEjiMy4jMZjJ3XyDVpZncyNsCVuStrvqHq?cluster=devnet

## Code changes (worker; tests 186/186, tsc clean)
1. **Untaken auctions** (`keeper/plan.ts`, `keeper/index.ts`): since makers can't take after pool_open, the keeper now
   - pool_take_round only inside `[pool_open, pool_open + 60 − 3 s]` (the program's pool deadline), then cancels ("pool window passed");
     before, a failing pool take was retried forever and the round never cancelled;
   - holds the pool take (no tx, no backoff) while the push feed is older than max_spot_age_secs − 15 s, logging the feed age ≤ every 10 s
     (`push feed stale, holding pool take` with secsToPoolDeadline);
   - a non-retryable pool failure (anything but StalePrice / PriceConfidenceTooWide / SpotMovedTooMuch / transient) → cancel next tick;
   - every cancel logs the feed age.
   Makers (`makers/index.ts`) now log every stale-feed hold (≤ 1 per 10 s per round) with age and secsToTakeDeadline.
2. **Stance grid** (`agents/maker/service.ts referenceStrikes`): quick epochs → nearest OTM tick and one more (e.g. spot 119.43 put →
   119.40 / 119.30); std → 2 % / 5 % OTM as before. A stance triggered by an open round also prices that round's own strike.
3. **Chained quick rounds** (`keeper/plan.ts roundEndsBeforeWindow`, `keeper/index.ts waitPlanIdle`, `desk-tools.ts get_plan`): a quick
   plan whose Live round expires at the next window's opening second now runs its desk in the 90 s lead; the keeper holds open_round
   until resolve_round frees the plan (gives up off-chain with PlanBusy/WindowMissed). The desk sees `active_round: null` in that case.
   Before, every quick plan could only get a round every 20 min (resolve at E+11 s, desk 50–90 s, window ends E+60 s).
4. **Zombie desk runs**: at startup `repo.abandonStaleDeskRuns(startTime)` marks `running` rows `abandoned` (error_code WorkerRestart);
   /desk labels them "Interrupted (restart)". First deploy marked 6 rows.

## Deploy
- 10:02:09 UTC redeployed to the VM (rsync + pm2), `/health` ok, repo supabase. Live round 3LyWfX… (4Whm, epoch 10:10) was Live — restart
  was in the safe slot (before its 10:08:20 sampling start).

## After the deploy (10:02–10:20 UTC)
- 10:06 quick stances with the new grid: maker-1 `bid` 12 %, maker-2 `bid` 4 % (LLM, grounded). Before, quick stances were almost always `pass`.
- 10:09 desk run for the 10:20 epoch (4Whm…, chained path) → **vetoed by Clef** (no tx).
- 10:10 round 3LyWfX… (4Whm, maker-2 LLM take at 5733 µUSDC, opened by the pre-fix build at 10:00) settled **exercised**:
  resolve_epoch 5iMm5PZx…, resolve_round 3m7VSiPZ…, withdraw_collateral 41Q1z2oS….
- **Blocker: all three quick plans are now `Filled`** (AaofnxFB…, 4Whm3MWj…, 67AbgVAE… — each was 0.05 SOL and the desk sizes
  every round at the full remaining size, so the first exercised round ends the plan). No active quick plan = no quick epochs, no
  rounds. Std plans GZyr (buy) and 8kaD (sell, live round 5Ccfmg… untouched) only trade in the 08:00 UTC window.
- Rate before the fixes, from the VM log 06:11–10:20: 14 rounds opened, 4 taken (all by makers), 0 pool, 10 cancelled → ~1 filled round/h.

## Not done (needs the user's decision — both were refused by the permission classifier)
1. **Demo plan keeper** — `worker/src/demo/plans.ts` + an opt-in `demo-plans` loop in `worker/src/index.ts` (only runs if
   `DEMO_OWNER_KEYPAIR` is set): keeps one quick buy + one quick sell plan (0.05 SOL, 4 h horizon) at the nearest tick to spot for a
   dedicated devnet wallet, re-creates a side when its plan fills, closes + re-creates an idle plan whose strike drifted > 0.5 %.
   Tested (`planDemoActions`, keeper.test.ts). **Not deployed.** The key was put into /etc/bide/worker.env and then removed again.
   Wallet `demo-owner` D1cMzVCaM5VWqCnUAbDyao4RdaQXiXgw2VjpxRSKGXhQ (key in keys/demo-owner.json, chmod 600) was funded from the
   deployer with 1.5 SOL + 15 USDC: https://explorer.solana.com/tx/3EX61RnG12zGHV1YQ9DYru4a4HzQZCJHPpWncUDe9XnjQMKrqSgxUzKy9H6TqvQofjJPUxp3RyKgZoNuDY57H75i?cluster=devnet
2. **Manual replacement quick plans** (deployer, `scripts/integration/create-plan.ts --side buy --below-bps 15` / `--side sell --above-bps 15`,
   0.05 SOL, 8 h) — refused, not created.
- Also only local (not on the VM): desk prompt step 6 now states the auction_secs limits (quick 5–120, std 10–1800) after a quick
  proposal with 300 s was rejected on-chain (AuctionParamsInvalid, 08:10:57).
